import { createHmac } from 'node:crypto';
import { AppError } from '../../../domain/errors.js';
import type { Clock } from '../../../lib/clock.js';
import { safeEqualHex } from '../../../lib/ids.js';
import type { Logger } from '../../../lib/logger.js';
import type { BookingRepository, ProcessedEventRepository } from '../../../repositories/types.js';
import type { SupportService } from '../../../services/SupportService.js';
import { DuffelWebhookEvent } from './schemas.js';

export const DUFFEL_SIGNATURE_HEADER = 'x-duffel-signature';
const TOLERANCE_SECONDS = 300;

/**
 * Duffel webhooks (https://duffel.com/docs/guides/receiving-webhooks).
 * Signature: `X-Duffel-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
 * We add a replay window and dedupe by event ID, since Duffel may redeliver.
 *
 * Airline schedule changes cannot be accepted or rejected automatically: they
 * open a support ticket so a person contacts the traveller.
 */
export class DuffelWebhookHandler {
  constructor(
    private readonly secret: string,
    private readonly bookings: BookingRepository,
    private readonly events: ProcessedEventRepository,
    private readonly support: SupportService,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  sign(rawBody: string, t: number): string {
    return `t=${t},v1=${createHmac('sha256', this.secret).update(`${t}.${rawBody}`).digest('hex')}`;
  }

  verify(rawBody: string, header: string | undefined): void {
    const parts = Object.fromEntries((header ?? '').split(',').map((p) => p.trim().split('=', 2) as [string, string]));
    const t = Number(parts['t']);
    const v1 = parts['v1'];
    if (!Number.isInteger(t) || !v1) throw new AppError('UNAUTHENTICATED', 'Invalid Duffel signature.');
    if (Math.abs(this.clock.now().getTime() / 1000 - t) > TOLERANCE_SECONDS) throw new AppError('UNAUTHENTICATED', 'Duffel webhook timestamp outside tolerance.');
    const expected = this.sign(rawBody, t).split('v1=')[1] ?? '';
    if (!safeEqualHex(expected, v1)) throw new AppError('UNAUTHENTICATED', 'Invalid Duffel signature.');
  }

  async handle(rawBody: string, signature: string | undefined): Promise<{ status: 'processed' | 'duplicate' | 'ignored' }> {
    this.verify(rawBody, signature);
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw new AppError('VALIDATION_FAILED', 'Malformed webhook body.');
    }
    const parsed = DuffelWebhookEvent.safeParse(json);
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', 'Unrecognised webhook payload.');
    const event = parsed.data;
    const dedupeKey = `duffel:${event.idempotency_key ?? event.id}`;

    if (event.type !== 'order.airline_initiated_change_detected') {
      return { status: 'ignored' };
    }

    const object = event.data?.object ?? {};
    const orderId = typeof object['order_id'] === 'string' ? object['order_id'] : typeof object['id'] === 'string' ? object['id'] : undefined;
    const booking = orderId ? await this.bookings.findBySupplierReference('duffel', orderId) : undefined;
    if (!booking) {
      this.log.warn('duffel.change_for_unknown_order', { eventId: event.id });
      return { status: 'ignored' };
    }
    // Claim first so a redelivery cannot open a second ticket.
    if (!(await this.events.markIfNew(dedupeKey))) return { status: 'duplicate' };
    await this.support.open(
      booking.ownerSessionId,
      'change_request',
      `Airline schedule change on booking ${booking.pnr} (supplier order ${orderId}). Review the change with the airline and contact the traveller to accept or rebook.`,
      { bookingId: booking.id },
    );
    this.log.warn('duffel.schedule_change', { bookingId: booking.id, pnr: booking.pnr });
    return { status: 'processed' };
  }
}
