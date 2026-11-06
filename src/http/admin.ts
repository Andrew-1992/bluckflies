import { createHash, timingSafeEqual } from 'node:crypto';
import express, { type RequestHandler, type Response, type Router } from 'express';
import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import type { Logger } from '../lib/logger.js';
import type { StaffAuthService, StaffPrincipal } from '../services/StaffAuthService.js';
import type { StaffRole } from '../repositories/types.js';
import type { FxService } from '../services/FxService.js';
import type { SupportService } from '../services/SupportService.js';
import { MANUAL_REFUND_PREFIX, type PaymentService } from '../services/PaymentService.js';
import type { Decision, ManualPaymentDesk } from '../services/ManualPaymentDesk.js';
import type { ReportService } from '../services/ReportService.js';
import { formatCharge } from '../lib/fx.js';
import { parseMinorUnits } from '../lib/money.js';
import type { RateLimiter } from '../lib/rateLimiter.js';
import { parseBody, rateLimit } from './middleware.js';

/**
 * Operator API, protected by a static bearer token (ADMIN_API_TOKEN):
 * - exchange rates for charging mobile-money wallets in SSP;
 * - the support desk (requests from travellers, airline changes, manual refunds).
 * Changes are attributed to the staff member named in the X-Staff-Name header.
 * Keep this behind the reverse proxy's IP allowlist as well.
 */

const sha256 = (s: string) => createHash('sha256').update(s).digest();

/** Who is calling: a signed-in staff member, or the emergency admin token (attributed by X-Staff-Name). */
export type Principal = StaffPrincipal | { kind: 'token'; name: string; role: 'admin'; needs2fa: false };

/** Resolves the bearer token: a staff session first, then the break-glass ADMIN_API_TOKEN. */
export function authenticateStaff(staff: StaffAuthService, adminToken: string | undefined, log: Logger): RequestHandler {
  const expected = adminToken ? sha256(adminToken) : undefined;
  return async (req, res, next) => {
    const header = req.header('authorization') ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (given) {
      const principal = await staff.authenticate(given);
      if (principal) {
        res.locals['principal'] = principal satisfies Principal;
        return next();
      }
      // Compare fixed-length hashes in constant time (no length or timing leak).
      if (expected && timingSafeEqual(sha256(given), expected)) {
        const tokenPrincipal: Principal = { kind: 'token', name: `${staffName(req.header('x-staff-name'))} (admin token)`, role: 'admin', needs2fa: false };
        res.locals['principal'] = tokenPrincipal;
        log.info('admin.token_used', { ip: req.ip, name: tokenPrincipal.name, path: req.path });
        return next();
      }
    }
    log.warn('admin.auth_failed', { ip: req.ip });
    throw new AppError('UNAUTHENTICATED', 'Sign in to the support desk.');
  };
}

export function principalOf(res: Response): Principal {
  const p = res.locals['principal'] as Principal | undefined;
  if (!p) throw new AppError('UNAUTHENTICATED', 'Sign in to the support desk.');
  return p;
}

/** Allows only these roles; staff who still have to set up two-step login are refused. */
function allow(...roles: StaffRole[]): RequestHandler {
  return (_req, res, next) => {
    const p = principalOf(res);
    if (p.needs2fa) throw new AppError('FORBIDDEN', 'Set up two-step login before using the desk.');
    if (!roles.includes(p.role)) throw new AppError('FORBIDDEN', 'Your role does not allow this.');
    next();
  };
}

/** Partner agents only handle cash payments at their office. */
const PARTNER_REASONS = new Set(['cash_office']);

const ManualPaymentDecision = z.discriminatedUnion('received', [
  z.object({
    received: z.literal(true),
    amountUsd: z.string().max(20),
    /** The bank's transaction / deposit-slip reference, or the cash receipt number, for the audit trail. */
    reference: z.string().trim().min(2).max(60),
    note: z.string().trim().max(500).optional(),
  }),
  z.object({ received: z.literal(false), note: z.string().trim().max(500).optional() }),
]);

const NewStaff = z.object({
  email: z.string().trim().max(200),
  name: z.string().trim().regex(/^[\p{L}\p{N} .'-]{2,60}$/u, 'Name: 2–60 letters'),
  role: z.enum(['admin', 'agent', 'partner']),
  password: z.string().max(200),
});
const StaffPatch = z
  .object({
    name: z.string().trim().regex(/^[\p{L}\p{N} .'-]{2,60}$/u).optional(),
    role: z.enum(['admin', 'agent', 'partner']).optional(),
    disabled: z.boolean().optional(),
    password: z.string().max(200).optional(),
    reset2fa: z.literal(true).optional(),
    unlock: z.literal(true).optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Nothing to change');

const RateBody = z.object({
  currency: z.string().length(3),
  perUsd: z.string().max(20),
  asOf: z.string().max(40),
  source: z.string().max(200),
  confirmLargeChange: z.boolean().optional(),
});

const TicketStatus = z.enum(['open', 'in_progress', 'resolved']);
const TicketId = z.object({ id: z.string().regex(/^sup_[a-f0-9]{32}$/) });
const TicketPatch = z
  .object({ status: TicketStatus.optional(), assignee: z.string().trim().min(1).max(60).nullable().optional() })
  .refine((b) => b.status !== undefined || b.assignee !== undefined, 'Nothing to change');
const NoteBody = z.object({ body: z.string().trim().min(1).max(2000) });
const MessageBody = z.object({ text: z.string().trim().min(1).max(600) });

/** Staff name for the audit trail (no staff accounts yet: the shared token gates access). */
function staffName(header: string | undefined): string {
  const name = (header ?? '').trim();
  if (!/^[\p{L}\p{N} .'-]{2,60}$/u.test(name)) throw new AppError('VALIDATION_FAILED', 'Send your name in the X-Staff-Name header.');
  return name;
}

export function adminRouter(opts: {
  token: string | undefined;
  staff: StaffAuthService;
  fx: FxService;
  support: SupportService;
  payments: PaymentService;
  desk: ManualPaymentDesk;
  reports: ReportService;
  limits: RateLimiter;
  log: Logger;
}): Router {
  const r = express.Router();
  r.use(rateLimit(opts.limits, { windowMs: 60_000, max: 120, key: (req) => `admin:${req.ip}` }));
  r.use(authenticateStaff(opts.staff, opts.token, opts.log));
  const author = (res: Response) => principalOf(res).name;
  /** Partners may only open cash-payment tickets. */
  const ticketFor = async (id: string, res: Response) => {
    const detail = await opts.support.detail(id);
    if (principalOf(res).role === 'partner' && !PARTNER_REASONS.has(detail.ticket.reason)) throw new AppError('NOT_FOUND', 'No such ticket.');
    return detail;
  };

  // ----------------------------------------------------------- finance
  r.get('/reports/:kind', allow('admin'), async (req, res) => {
    const { kind } = parseBody(z.object({ kind: z.enum(['payments', 'daily', 'refunds-owed', 'ai-usage']) }), req.params);
    const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
    const { from, to } = parseBody(z.object({ from: day.optional(), to: day.optional() }), req.query);
    if (kind !== 'refunds-owed' && (!from || !to)) throw new AppError('VALIDATION_FAILED', 'Choose a start and end date.');
    const report = await opts.reports.csv(kind, from ?? '', to ?? '');
    opts.log.info('admin.report_downloaded', { kind, from, to, by: author(res) });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${report.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(report.body);
  });

  // ------------------------------------------------------------- staff
  r.get('/staff', allow('admin'), async (_req, res) => {
    res.json({ staff: await opts.staff.list() });
  });
  r.post('/staff', allow('admin'), async (req, res) => {
    const body = parseBody(NewStaff, req.body);
    res.status(201).json({ staff: await opts.staff.create(author(res), body) });
  });
  r.patch('/staff/:id', allow('admin'), async (req, res) => {
    const { id } = parseBody(z.object({ id: z.string().regex(/^stf_[a-f0-9]{32}$/) }), req.params);
    const change = parseBody(StaffPatch, req.body);
    const p = principalOf(res);
    const clean = Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined)) as Parameters<StaffAuthService['update']>[2];
    res.json({ staff: await opts.staff.update({ ...(p.kind === 'staff' ? { id: p.id } : {}), name: p.name }, id, clean) });
  });

  r.get('/fx-rates/:currency', allow('admin'), async (req, res) => {
    const { currency } = parseBody(z.object({ currency: z.string().regex(/^[A-Za-z]{3}$/) }), req.params);
    const current = await opts.fx.current(currency.toUpperCase());
    res.json({ current: current ?? null, history: await opts.fx.history(currency) });
  });

  r.post('/fx-rates', allow('admin'), async (req, res) => {
    const body = parseBody(RateBody, req.body);
    const rate = await opts.fx.setRate({
      currency: body.currency,
      perUsd: body.perUsd,
      asOf: body.asOf,
      source: body.source,
      ...(body.confirmLargeChange !== undefined ? { confirmLargeChange: body.confirmLargeChange } : {}),
    });
    opts.log.info('admin.fx_rate_set', { ip: req.ip, currency: rate.currency });
    res.status(201).json({ rate });
  });

  // ---------------------------------------------------------- support desk
  r.get('/tickets', allow('admin', 'agent', 'partner'), async (req, res) => {
    const { status } = parseBody(z.object({ status: TicketStatus.optional() }), req.query);
    const tickets = await opts.support.list(status);
    res.json({ tickets: principalOf(res).role === 'partner' ? tickets.filter((t) => PARTNER_REASONS.has(t.reason)) : tickets });
  });

  r.get('/tickets/:id', allow('admin', 'agent', 'partner'), async (req, res) => {
    const { id } = parseBody(TicketId, req.params);
    const detail = await ticketFor(id, res);
    const payment = detail.ticket.bookingId ? await opts.payments.latestForBooking(detail.ticket.bookingId) : undefined;
    res.json({
      ...detail,
      ...(payment
        ? {
            payment: {
              method: payment.method,
              status: payment.status,
              amountDue: formatCharge(payment.charge),
              provider: payment.provider,
              createdAt: payment.createdAt,
              // A refund the provider could not make: staff pay it and record it on this ticket.
              refundByHand: payment.status === 'refund_requested' && Boolean(payment.refundReference?.startsWith(MANUAL_REFUND_PREFIX)),
            },
          }
        : {}),
    });
  });

  // Staff confirm (or reject) a bank transfer, branch deposit or office cash payment.
  r.post('/tickets/:id/manual-payment', allow('admin', 'agent', 'partner'), async (req, res) => {
    const { id } = parseBody(TicketId, req.params);
    await ticketFor(id, res);
    const body = parseBody(ManualPaymentDecision, req.body);
    let decision: Decision;
    if (body.received) {
      const amountMinor = parseMinorUnits(body.amountUsd);
      if (amountMinor === undefined) throw new AppError('VALIDATION_FAILED', 'Enter the amount received in US dollars, e.g. 412.50.');
      decision = { received: true, amount: { amountMinor, currency: 'USD' }, reference: body.reference, ...(body.note ? { note: body.note } : {}) };
    } else {
      decision = { received: false, ...(body.note ? { note: body.note } : {}) };
    }
    res.json(await opts.desk.settleTicket(id, decision, author(res)));
  });

  // A refund staff paid by hand (bank transfer or cash at the office): the reference is required.
  r.post('/tickets/:id/refund-paid', allow('admin', 'agent'), async (req, res) => {
    const { id } = parseBody(TicketId, req.params);
    const body = parseBody(z.object({ reference: z.string().trim().min(2).max(80), note: z.string().trim().max(500).optional() }), req.body);
    res.json(await opts.desk.markRefundPaid(id, { reference: body.reference, ...(body.note ? { note: body.note } : {}) }, author(res)));
  });

  // Bank statement (CSV export) matched against open bank transfers. Without
  // ?apply it only previews; ?apply=<line ids> confirms those exact matches.
  r.post('/payments/bank-statement', allow('admin', 'agent'), express.text({ type: ['text/csv', 'text/plain', 'application/csv'], limit: '2mb' }), async (req, res) => {
    const csv = typeof req.body === 'string' ? req.body : '';
    if (!csv.trim()) throw new AppError('VALIDATION_FAILED', 'Send the statement as a CSV file (Content-Type: text/csv).');
    const { apply } = parseBody(z.object({ apply: z.string().regex(/^[0-9a-f]{16}(,[0-9a-f]{16}){0,499}$/).optional() }), req.query);
    res.json(await opts.desk.importStatement(csv, author(res), apply ? apply.split(',') : []));
  });

  r.patch('/tickets/:id', allow('admin', 'agent'), async (req, res) => {
    const { id } = parseBody(TicketId, req.params);
    const body = parseBody(TicketPatch, req.body);
    const change = { ...(body.status ? { status: body.status } : {}), ...(body.assignee !== undefined ? { assignee: body.assignee } : {}) };
    res.json({ ticket: await opts.support.update(id, change, author(res)) });
  });

  r.post('/tickets/:id/notes', allow('admin', 'agent', 'partner'), async (req, res) => {
    const { id } = parseBody(TicketId, req.params);
    const { body } = parseBody(NoteBody, req.body);
    await ticketFor(id, res);
    res.status(201).json({ note: await opts.support.addNote(id, author(res), body) });
  });

  r.post('/tickets/:id/messages', allow('admin', 'agent'), async (req, res) => {
    const { id } = parseBody(TicketId, req.params);
    const { text } = parseBody(MessageBody, req.body);
    res.status(201).json({ note: await opts.support.messageTraveller(id, author(res), text) });
  });

  return r;
}
