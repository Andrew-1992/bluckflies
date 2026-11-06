import type { Clock } from '../lib/clock.js';
import type { Logger } from '../lib/logger.js';
import type { BookingRepository, ProcessedEventRepository } from '../repositories/types.js';
import type { NotificationService } from './notifications/NotificationService.js';
import type { SupportService } from './SupportService.js';

/**
 * Turns critical log events into alerts for the operations team (email and
 * SMS through the outbox) and, where a booking needs a person, a support-desk
 * ticket. Each rule decides how alerts are deduplicated: once per booking or
 * payment, or at most once per hour/day for conditions that repeat.
 *
 * Delivery uses the database outbox, so a database outage cannot alert
 * through here: watch /readyz from an external uptime monitor for that.
 */

type Scope = { per: 'field'; field: string } | { per: 'hour' } | { per: 'day'; field?: string };

interface Rule {
  title: string;
  /** What to do, for the person reading the alert. */
  action: string;
  scope: Scope;
  /** Open a desk ticket on the booking (needs ctx.bookingId). */
  ticket?: boolean;
  /** Skip events that should not alert (e.g. failures of alert messages themselves). */
  when?: (ctx: Record<string, unknown>) => boolean;
}

const RULES: Record<string, Rule> = {
  'reconcile.ticketing_still_failing': {
    title: 'Paid booking not ticketed',
    action: 'The traveller has paid but tickets could not be issued. Check the airline/Duffel order now and issue or refund.',
    scope: { per: 'field', field: 'bookingId' },
    ticket: true,
  },
  'payment.amount_mismatch': {
    title: 'Payment amount does not match',
    action: 'A payment arrived with a different amount or currency, so no ticket was issued. Check with the traveller and the payment provider.',
    scope: { per: 'field', field: 'paymentId' },
    ticket: true,
  },
  'reconcile.refund_failed_needs_attention': {
    title: 'Refund failed',
    action: 'A refund owed to a traveller failed at the payment provider. Refund manually.',
    scope: { per: 'field', field: 'paymentId' },
    ticket: true,
  },
  'stripe.refund_failed': {
    title: 'Card refund failed (Stripe)',
    action: 'Stripe reports a failed refund. Check the Stripe Dashboard and refund another way.',
    scope: { per: 'field', field: 'refundId' },
  },
  'booking.unfulfillable_refunded': {
    title: 'Airline could not honour a paid fare',
    action: 'The traveller was refunded automatically. Call them to offer another flight.',
    scope: { per: 'field', field: 'bookingId' },
  },
  'booking.cancelled_at_supplier_but_state_changed': {
    title: 'Cancellation out of step with the airline',
    action: 'The airline order was cancelled but the booking changed meanwhile. Check the booking and the refund.',
    scope: { per: 'field', field: 'bookingId' },
    ticket: true,
  },
  'duffel.insufficient_balance': {
    title: 'Duffel balance too low: tickets cannot be issued',
    action: 'Top up the Duffel balance now. Paid bookings retry automatically once funds arrive.',
    scope: { per: 'hour' },
  },
  'duffel.auth_failed': {
    title: 'Duffel rejected the access token',
    action: 'Flight search and ticketing are failing. Check DUFFEL_ACCESS_TOKEN in the Duffel dashboard.',
    scope: { per: 'hour' },
  },
  'agent.provider_error': {
    title: 'AI assistant unavailable',
    action: 'Claude API calls are failing (status in details). Check Anthropic Console billing, the API key and status.anthropic.com. Travellers can still use the step-by-step search.',
    scope: { per: 'hour' },
  },
  'agent.daily_budget_warning': {
    title: 'AI assistant at 80% of its daily budget',
    action: 'Spending on the AI model is high today (amounts in details). Check the AI usage report for unusual conversations. Raise AGENT_DAILY_BUDGET_USD only if the traffic is genuine.',
    scope: { per: 'day', field: 'day' },
  },
  'agent.daily_budget_reached': {
    title: 'AI assistant paused: daily budget reached',
    action: 'The assistant is off until midnight Juba time; travellers can still search step by step and ask to be called. Check the AI usage report, then raise AGENT_DAILY_BUDGET_USD and restart if the traffic is genuine.',
    scope: { per: 'day', field: 'day' },
  },
  'fx.rate_stale': {
    title: 'SSP exchange rate is out of date',
    action: "Mobile-money payments in SSP are paused. Post today's rate on the admin API.",
    scope: { per: 'day', field: 'currency' },
  },
  'notification.failed': {
    title: 'Messages to travellers are failing',
    action: 'E-tickets or login codes could not be delivered after retries. Check the email (Resend) or SMS (Twilio) account.',
    scope: { per: 'hour' },
    when: (ctx) => !String(ctx['key'] ?? '').startsWith('alert:'),
  },
  'auth.otp_send_failed': {
    title: 'Login codes by SMS are failing',
    action: 'Travellers cannot sign in by phone. Check the Twilio account and balance.',
    scope: { per: 'hour' },
  },
  'jobs.failed': {
    title: 'Background job failing',
    action: 'A scheduled job (holds, reconciliation, messages or cleanup) is failing. Check the server logs.',
    scope: { per: 'hour' },
  },
  'request.unhandled': {
    title: 'Unexpected server errors',
    action: 'Requests are failing with unexpected errors. Check the server logs for request.unhandled.',
    scope: { per: 'hour' },
  },
};

export const ALERT_EVENTS = Object.keys(RULES);

export class AlertService {
  constructor(
    private readonly notifications: NotificationService,
    private readonly support: SupportService,
    private readonly bookings: BookingRepository,
    private readonly events: ProcessedEventRepository,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly opts: { emails: readonly string[]; phones: readonly string[] },
  ) {}

  /** Logger sink: fire and forget, never throws. */
  onLog = (event: string, ctx: Record<string, unknown>): void => {
    const rule = RULES[event];
    if (!rule || (rule.when && !rule.when(ctx))) return;
    this.raise(event, rule, ctx).catch((err: unknown) => this.log.warn('alert.failed', { event, err: err instanceof Error ? err.message : String(err) }));
  };

  private scopeKey(rule: Rule, ctx: Record<string, unknown>): string | undefined {
    const now = this.clock.now().toISOString();
    switch (rule.scope.per) {
      case 'field': {
        const v = ctx[rule.scope.field];
        return typeof v === 'string' && v ? v : undefined;
      }
      case 'hour':
        return now.slice(0, 13);
      case 'day': {
        const extra = rule.scope.field ? ctx[rule.scope.field] : undefined;
        return `${now.slice(0, 10)}${typeof extra === 'string' ? `:${extra}` : ''}`;
      }
    }
  }

  async raise(event: string, rule: Rule, ctx: Record<string, unknown>): Promise<void> {
    const scope = this.scopeKey(rule, ctx);
    if (!scope) return;
    const key = `alert:${event}:${scope}`;
    if (!(await this.events.markIfNew(key))) return; // already alerted for this booking / hour / day

    const bookingId = typeof ctx['bookingId'] === 'string' ? ctx['bookingId'] : undefined;
    const booking = bookingId ? await this.bookings.findById(bookingId) : undefined;
    const details = Object.entries(ctx)
      .filter(([k]) => !/phone|email|passport|token|secret/i.test(k))
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v.slice(0, 200) : JSON.stringify(v)}`)
      .join('\n');
    const subject = `[BluckFlies ALERT] ${rule.title}${booking ? ` (${booking.pnr})` : ''}`;
    const body = `${rule.title}${booking ? ` for booking ${booking.pnr}` : ''}.\n\n${rule.action}\n\nEvent: ${event}\n${details}\nTime: ${this.clock.now().toISOString()}`;
    const sms = `BluckFlies ALERT: ${rule.title}${booking ? ` ${booking.pnr}` : ''}. ${rule.action}`.slice(0, 300);
    await this.notifications.opsAlert(key, subject, body, sms, this.opts);
    if (rule.ticket && booking) {
      await this.support.open(booking.ownerSessionId, 'system_alert', `${rule.title}. ${rule.action}`, { bookingId: booking.id });
    }
    this.log.info('alert.raised', { event, key });
  }
}
