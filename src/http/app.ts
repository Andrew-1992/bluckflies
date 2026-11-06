import express, { type Express } from 'express';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Container } from '../container.js';
import type { BookingView } from '../services/BookingService.js';
import { AppError } from '../domain/errors.js';
import { newId, hashToken, newSessionToken } from '../lib/ids.js';
import { withTimeout } from '../lib/withTimeout.js';
import { ETICKET_PATH } from '../services/ETicketService.js';
import { normalizePhone } from '../lib/phone.js';
import { DPO_RETURN_PATH } from '../providers/payments/dpo/DpoPaymentProvider.js';
import { STRIPE_SIGNATURE_HEADER } from '../providers/payments/StripeWebhookHandler.js';
import { DUFFEL_SIGNATURE_HEADER } from '../providers/flights/duffel/DuffelWebhookHandler.js';
import { SANDBOX_SIGNATURE_HEADER } from '../services/PaymentService.js';
import { adminRouter } from './admin.js';
import { staffRouter } from './staff.js';
import { channelRoutes } from './channels.js';
import { legalRoutes } from './legal.js';
import { webClientRoutes } from './webClient.js';
import { transcriptOf } from '../agent/transcript.js';
import { STOPPED_TEXT, type HandleOptions } from '../agent/Agent.js';
import { streamChatTurn } from './chatStream.js';
import { errorHandler, parseBody, rateLimit, requestId, requireOriginSecret, requireSession, securityHeaders } from './middleware.js';

const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const DirectSearch = z
  .object({
    origin: z.string().trim().min(2).max(80),
    destination: z.string().trim().min(2).max(80),
    departureDate: IsoDay,
    returnDate: IsoDay.optional(),
    adults: z.number().int().min(1).max(9),
    childAges: z.array(z.number().int().min(2).max(11)).max(8).default([]),
    infants: z.number().int().min(0).max(4).default(0),
    cabin: z.enum(['economy', 'premium_economy', 'business', 'first']).default('economy'),
  })
  .refine((b) => b.adults + b.childAges.length + b.infants <= 9, 'At most 9 travellers');
const BookingRequest = z.object({
  /** The flight they chose; absent for a general "call me" request (e.g. Help). */
  offerId: z.string().min(4).max(100).optional(),
  /** What they asked, when there is no chosen flight. */
  message: z.string().trim().max(500).optional(),
  name: z.string().trim().min(2).max(80),
  phone: z.string().trim().min(6).max(25),
  language: z.enum(['en', 'ar']).optional(),
});

const ChatBody = z.object({
  message: z.string().trim().min(1).max(2000),
  /** "voice" when the message was spoken and the reply will be read aloud. */
  channel: z.enum(['text', 'voice']).default('text'),
});
const ConfirmationParams = z.object({ id: z.string().regex(/^cnf_[a-f0-9]{32}$/) });
const BookingParams = z.object({ reference: z.string().min(6).max(100) });
const SandboxOutcome = z.object({ outcome: z.enum(['succeeded', 'failed']) });
const OtpStart = z.object({ phone: z.string().trim().min(6).max(30), language: z.enum(['en', 'ar']).default('en') });
const OtpVerify = z.object({ challengeId: z.string().regex(/^otp_[a-f0-9]{32}$/), code: z.string().trim().min(4).max(12) });

const PUBLIC_DIR = fileURLToPath(new URL('../../public', import.meta.url));

export function createApp(c: Container): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', c.config.TRUST_PROXY_HOPS); // proxies in front (TLS termination, load balancer)
  app.use(requestId, securityHeaders());
  if (c.config.ORIGIN_SECRET) app.use(requireOriginSecret(c.config.ORIGIN_SECRET));
  // API answers belong to one traveller: never stored by a browser, proxy or CDN (routes may set their own).
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Webhooks need the exact raw bytes for signature verification, so these
  // routes are registered before the JSON parser.
  const rawJson = express.raw({ type: 'application/json', limit: '256kb' });
  const stripeWebhooks = c.stripeWebhooks;
  if (stripeWebhooks) {
    app.post('/api/webhooks/stripe', rawJson, async (req, res) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      res.json(await stripeWebhooks.handle(raw, req.header(STRIPE_SIGNATURE_HEADER)));
    });
  }
  if (c.momoEnabled) {
    // MTN callbacks are unsigned: the body only tells us which payment to
    // re-check, and the status is always read back from MTN itself.
    const momoLimiter = rateLimit(c.limits, { windowMs: 60_000, max: 120, key: (req) => `momo:${req.ip}` });
    const MomoCallback = z.object({
      externalId: z.uuid().optional(),
      referenceId: z.uuid().optional(),
    });
    const onMomoCallback = async (req: express.Request, res: express.Response) => {
      let body: unknown = {};
      try {
        body = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '{}');
      } catch {
        // fall through: nothing to look up
      }
      const parsed = MomoCallback.safeParse(body);
      const ref = parsed.success ? (parsed.data.referenceId ?? parsed.data.externalId) : undefined;
      const outcome = ref ? await c.reconciliation.checkByReference('mtn_momo', ref) : 'unknown';
      res.json({ status: outcome });
    };
    app.post('/api/webhooks/momo', momoLimiter, rawJson, onMomoCallback);
    app.put('/api/webhooks/momo', momoLimiter, rawJson, onMomoCallback);
  }

  if (c.dpoEnabled) {
    // DPO sends the traveller back here (RedirectURL) and may also notify this
    // address (BackURL). Neither is signed, so the request only names a token
    // to re-check; the status always comes from DPO's verifyToken.
    const dpoLimiter = rateLimit(c.limits, { windowMs: 60_000, max: 120, key: (req) => `dpo:${req.ip}` });
    const TOKEN = /^[A-Za-z0-9-]{10,64}$/;
    const tokenFrom = (req: express.Request): string | undefined => {
      const q = req.query['TransactionToken'] ?? req.query['TransID'];
      if (typeof q === 'string' && TOKEN.test(q)) return q;
      const raw = typeof req.body === 'string' ? req.body : '';
      const m = /<TransactionToken>([^<]+)<\/TransactionToken>/.exec(raw) ?? /(?:^|&)TransactionToken=([^&]+)/.exec(raw);
      const v = m?.[1] ? decodeURIComponent(m[1].trim()) : undefined;
      return v && TOKEN.test(v) ? v : undefined;
    };
    const onDpoReturn = async (req: express.Request, res: express.Response) => {
      const token = tokenFrom(req);
      let outcome: 'success' | 'failed' | 'pending' = 'pending';
      let pnr: string | undefined;
      if (token) {
        await c.reconciliation.checkByReference('dpo', token);
        const payment = await c.repos.payments.findByProviderReference(token);
        if (payment?.provider === 'dpo') {
          pnr = (await c.repos.bookings.findById(payment.bookingId))?.pnr;
          if (payment.status === 'succeeded' || payment.status === 'refund_requested' || payment.status === 'refunded') outcome = 'success';
          else if (payment.status === 'failed' || payment.status === 'cancelled') outcome = 'failed';
        }
      }
      if (req.method === 'GET') {
        res.redirect(303, `/?payment=${outcome}${pnr ? `&ref=${encodeURIComponent(pnr)}` : ''}`);
      } else {
        res.type('text/plain').send('OK');
      }
    };
    app.get(DPO_RETURN_PATH, dpoLimiter, onDpoReturn);
    app.post(DPO_RETURN_PATH, dpoLimiter, express.text({ type: '*/*', limit: '64kb' }), onDpoReturn);
  }

  const duffelWebhooks = c.duffelWebhooks;
  if (duffelWebhooks) {
    app.post('/api/webhooks/duffel', rawJson, async (req, res) => {
      const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      res.json(await duffelWebhooks.handle(raw, req.header(DUFFEL_SIGNATURE_HEADER)));
    });
  }
  channelRoutes(app, c);

  if (c.config.ENABLE_SANDBOX_ENDPOINTS) {
    app.post('/api/webhooks/sandbox', rawJson, async (req, res) => {
      const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      res.json(await c.payments.handleSandboxWebhook(raw, req.header(SANDBOX_SIGNATURE_HEADER)));
    });
  }

  app.use(express.json({ limit: '32kb' }));

  // Liveness: the process is up. Never touches dependencies, so a database
  // outage does not get healthy containers restarted in a loop.
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', agent: c.agent ? (c.agentMode === 'demo' ? 'demo' : 'ready') : 'unconfigured', flights: c.flightInventory, cardPayments: c.cardProvider, storage: c.storage });
  });

  // Readiness: can this instance serve traffic right now? Load balancers stop
  // routing here while the database is unreachable.
  app.get('/readyz', async (_req, res) => {
    try {
      await withTimeout('Database check', 2_000, () => c.repos.ping());
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'unavailable', reason: 'database' });
    }
  });

  const ipLimiter = rateLimit(c.limits, { windowMs: 60_000, max: 20, key: (req) => `ip:${req.ip}` });
  app.post('/api/sessions', ipLimiter, async (_req, res) => {
    const token = newSessionToken();
    const now = new Date().toISOString();
    await c.sessions.create({ id: newId('ses'), tokenHash: hashToken(token), createdAt: now, lastSeenAt: now });
    res.status(201).json({ token });
  });

  // Printable e-ticket behind a signed link (from the e-ticket email or the booking card).
  app.get(`${ETICKET_PATH}:token`, rateLimit(c.limits, { windowMs: 60_000, max: 30, key: (req) => `eticket:${req.ip}` }), async (req, res) => {
    const id = c.etickets.bookingIdFor(String(req.params['token'] ?? ''));
    const booking = id ? await c.repos.bookings.findById(id) : undefined;
    if (!booking || booking.status !== 'ticketed') {
      res.status(404).type('text/plain').send('This e-ticket link is not valid or has expired. Open "My tickets" in BluckFlies for a new link.');
      return;
    }
    const payment = await c.payments.latestForBooking(booking.id);
    const pdf = c.etickets.render(booking, payment?.method);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="BluckFlies-${booking.pnr}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.send(pdf);
  });

  // Public: which ways to pay are switched on, so the client only shows those.
  app.get('/api/payment-options', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.json({ methods: c.payments.availableMethods(), cardProvider: c.cardProvider });
  });

  const api = express.Router();
  api.use(requireSession(c.sessions));

  // Direct search (the step-by-step finder): works without the AI assistant.
  const searchLimiter = rateLimit(c.limits, { windowMs: 60_000, max: 20, key: (req) => `search:${req.sessionId}` });
  api.post('/search', searchLimiter, async (req, res) => {
    const b = parseBody(DirectSearch, req.body);
    res.json(
      await c.search.search(req.sessionId ?? '', {
        origin: b.origin,
        destination: b.destination,
        departureDate: b.departureDate,
        ...(b.returnDate ? { returnDate: b.returnDate } : {}),
        passengers: { adults: b.adults, childAges: b.childAges, infants: b.infants },
        cabin: b.cabin,
        maxStops: 1,
        sortBy: 'best',
      }),
    );
  });

  // When the assistant is unavailable: the traveller leaves a phone number and
  // staff call back to book the chosen flight (support desk ticket).
  api.post('/booking-requests', rateLimit(c.limits, { windowMs: 60 * 60_000, max: 5, key: (req) => `bookreq:${req.sessionId}` }), async (req, res) => {
    const b = parseBody(BookingRequest, req.body);
    const phone = normalizePhone(b.phone);
    if (!phone) throw new AppError('VALIDATION_FAILED', 'Enter a phone number, for example 0912 345 678 or +211 912 345 678.');
    const sessionId = req.sessionId ?? '';
    const lang = b.language === 'ar' ? ' Prefers Arabic.' : '';
    let summary: string;
    if (b.offerId) {
      const offer = await c.search.getOffer(sessionId, b.offerId);
      const s = await c.search.describe(offer);
      const leg = (x: (typeof s.segments)[number]) => `${x.flight} ${x.from}-${x.to} ${x.departs.slice(0, 16).replace('T', ' ')}`;
      const flights = `${s.segments.map(leg).join('; ')}${s.return ? `; RETURN ${s.return.segments.map(leg).join('; ')}` : ''}`;
      summary = `Please call ${b.name} to book: ${flights}. ${s.passengers}, ${offer.cabin.replace('_', ' ')}, ${s.price} (offer ${offer.id}, valid until ${offer.expiresAt}; search again if it expired).${lang}`;
    } else {
      summary = `Please call ${b.name} back.${b.message ? ` They wrote: "${b.message}"` : ''}${lang}`;
    }
    const ticket = await c.support.open(sessionId, b.offerId ? 'booking_request' : 'callback_request', summary, { contactPhone: phone });
    res.status(201).json({ requestId: ticket.ticketId });
  });

  const chatLimiter = rateLimit(c.limits, { windowMs: 60_000, max: 15, key: (req) => `chat:${req.sessionId}` });
  const AGENT_DOWN = 'The BluckFlies assistant is not available right now. You can still find flights step by step, or call us.';
  /** One chat turn and the reply body shared by the JSON and streaming endpoints. */
  const chatTurn = async (sessionId: string, body: unknown, events: HandleOptions = {}): Promise<Record<string, unknown>> => {
    if (!c.agent) throw new AppError('AGENT_UNAVAILABLE', AGENT_DOWN);
    const { message, channel } = parseBody(ChatBody, body);
    const turn = await c.agent.handle(sessionId, message, { channel, ...events });
    const pendingConfirmations = await c.confirmations.listPending(sessionId);
    // `search` carries the offers the agent just found, for result cards; the reply text stays the source of truth.
    return { reply: turn.reply, stopped: turn.reply === STOPPED_TEXT, pendingConfirmations, searches: turn.searches, ...(turn.search ? { search: turn.search } : {}) };
  };
  api.post('/chat', chatLimiter, async (req, res) => {
    res.json(await chatTurn(req.sessionId ?? '', req.body));
  });
  // Same turn, with progress: which step the assistant is on, and the reply as it is written.
  api.post('/chat/stream', chatLimiter, async (req, res) => {
    // Problems known before any work answer as ordinary JSON errors.
    if (!c.agent) throw new AppError('AGENT_UNAVAILABLE', AGENT_DOWN);
    parseBody(ChatBody, req.body);
    await streamChatTurn(req, res, c.log, (err) => c.repos.isUnavailable(err), (onEvent, signal) => chatTurn(req.sessionId ?? '', req.body, { onEvent, signal }));
  });

  // Restores the conversation after a page refresh (text only; no tool data).
  api.get('/chat/history', async (req, res) => {
    const sessionId = req.sessionId ?? '';
    const messages = c.agent ? transcriptOf(await c.repos.conversations.load(sessionId), 80) : [];
    res.json({ messages, pendingConfirmations: await c.confirmations.listPending(sessionId) });
  });

  // ---------------------------------------------------------- phone login
  const otpStartLimiter = rateLimit(c.limits, { windowMs: 10 * 60_000, max: 5, key: (req) => `otp-start:${req.ip}` });
  const otpVerifyLimiter = rateLimit(c.limits, { windowMs: 10 * 60_000, max: 10, key: (req) => `otp-verify:${req.sessionId}` });
  api.get('/me', async (req, res) => {
    res.json({ account: await c.auth.me(req.sessionId ?? ''), phoneLogin: c.auth.enabled });
  });
  api.post('/auth/otp/start', otpStartLimiter, async (req, res) => {
    const { phone, language } = parseBody(OtpStart, req.body);
    res.status(202).json(await c.auth.start(req.sessionId ?? '', phone, language));
  });
  api.post('/auth/otp/verify', otpVerifyLimiter, async (req, res) => {
    const { challengeId, code } = parseBody(OtpVerify, req.body);
    res.json({ account: await c.auth.verify(req.sessionId ?? '', challengeId, code) });
  });
  api.post('/auth/logout', async (req, res) => {
    await c.auth.logout(req.sessionId ?? '');
    res.status(204).end();
  });

  api.get('/confirmations', async (req, res) => {
    res.json({ pendingConfirmations: await c.confirmations.listPending(req.sessionId ?? '') });
  });

  // The human approval step. Only the traveller's client calls this; the agent has no tool for it.
  api.post('/confirmations/:id/confirm', async (req, res) => {
    const { id } = parseBody(ConfirmationParams, req.params);
    res.json({ booking: await c.confirmations.approve(req.sessionId ?? '', id) });
  });

  api.post('/confirmations/:id/decline', async (req, res) => {
    const { id } = parseBody(ConfirmationParams, req.params);
    await c.confirmations.decline(req.sessionId ?? '', id);
    res.status(204).end();
  });

  const withPayment = async (view: BookingView) => {
    const p = await c.payments.latestForBooking(view.bookingId);
    return { ...view, ...(p ? { payment: c.payments.toView(p) } : {}) };
  };

  api.get('/bookings', async (req, res) => {
    const views = await c.bookings.list(req.sessionId ?? '');
    res.json({ bookings: await Promise.all(views.map(withPayment)) });
  });

  api.get('/bookings/:reference', async (req, res) => {
    const { reference } = parseBody(BookingParams, req.params);
    res.json({ booking: await withPayment(await c.bookings.view(req.sessionId ?? '', reference)) });
  });

  if (c.config.ENABLE_SANDBOX_ENDPOINTS) {
    // Simulates the traveller approving (or declining) the mobile-money prompt.
    // Goes through the real signed-webhook path so verification is exercised.
    api.post('/sandbox/bookings/:reference/payment', async (req, res) => {
      const { reference } = parseBody(BookingParams, req.params);
      const { outcome } = parseBody(SandboxOutcome, req.body);
      const booking = await c.bookings.getOwned(req.sessionId ?? '', reference);
      const payment = await c.payments.latestForBooking(booking.id);
      if (!payment || payment.status !== 'requested') throw new AppError('INVALID_STATE', 'No payment request is awaiting approval.');
      if (!payment.provider.startsWith('sandbox')) throw new AppError('INVALID_STATE', 'This payment is handled by a real provider. Complete it on the payment page.');
      const body = JSON.stringify({
        id: newId('evt'),
        type: outcome === 'succeeded' ? 'payment.succeeded' : 'payment.failed',
        data: { providerReference: payment.providerReference, amountMinor: payment.charge.amountMinor, currency: payment.charge.currency, ...(outcome === 'failed' ? { reason: 'declined_by_payer' } : {}) },
      });
      await c.payments.handleSandboxWebhook(body, c.payments.sign(body, Math.floor(c.clock.now().getTime() / 1000)));
      res.json({ booking: await withPayment(await c.bookings.view(req.sessionId ?? '', reference)) });
    });
  }

  // Support desk: staff accounts (and the optional break-glass ADMIN_API_TOKEN).
  app.use('/api/staff', staffRouter(c.staff, c.limits));
  app.use('/api/admin', adminRouter({ token: c.config.ADMIN_API_TOKEN, staff: c.staff, fx: c.fx, support: c.support, payments: c.payments, desk: c.manualPayments, reports: c.reports, limits: c.limits, log: c.log }));
  app.use('/api', api);
  // Pages link to versioned asset URLs, so an update never mixes with cached files.
  legalRoutes(app, c.config);
  webClientRoutes(app, PUBLIC_DIR, c.config.PUBLIC_BASE_URL);
  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
  });
  app.use(errorHandler(c.log, (err) => c.repos.isUnavailable(err)));
  return app;
}
