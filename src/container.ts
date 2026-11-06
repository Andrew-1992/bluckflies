import { BluckFliesAgent } from './agent/Agent.js';
import { AnthropicLlmClient, type LlmClient } from './agent/llm.js';
import { DemoLlmClient } from './agent/demoLlm.js';
import { ToolExecutor } from './agent/ToolExecutor.js';
import { configuredPrices } from './agent/pricing.js';
import { RateLimiter } from './lib/rateLimiter.js';
import { AgentBudget } from './services/AgentBudget.js';
import type { Booking } from './domain/types.js';
import type { AppConfig } from './config/env.js';
import { buildJobs } from './jobs/definitions.js';
import { systemClock, type Clock } from './lib/clock.js';
import { AesGcmFieldCipher, parseKeyring } from './lib/fieldCipher.js';
import { JobScheduler } from './lib/jobs.js';
import type { Logger } from './lib/logger.js';
import type { FlightProvider } from './providers/flights/FlightProvider.js';
import { SandboxFlightProvider } from './providers/flights/SandboxFlightProvider.js';
import { RoutedFlightProvider } from './providers/flights/RoutedFlightProvider.js';
import { DuffelClient } from './providers/flights/duffel/DuffelClient.js';
import { DuffelFlightProvider } from './providers/flights/duffel/DuffelFlightProvider.js';
import { DuffelWebhookHandler } from './providers/flights/duffel/DuffelWebhookHandler.js';
import { PaymentGateway, type PaymentProvider } from './providers/payments/PaymentProvider.js';
import { SandboxPaymentProvider } from './providers/payments/SandboxPaymentProvider.js';
import { MomoClient } from './providers/payments/momo/MomoClient.js';
import { MomoPaymentProvider } from './providers/payments/momo/MomoPaymentProvider.js';
import { FxService } from './services/FxService.js';
import { DpoClient } from './providers/payments/dpo/DpoClient.js';
import { DpoPaymentProvider } from './providers/payments/dpo/DpoPaymentProvider.js';
import { BankTransferPaymentProvider, DEMO_BANK_ACCOUNT } from './providers/payments/BankTransferPaymentProvider.js';
import { CashOfficePaymentProvider, DEMO_CASH_OFFICES, parseCashOffices } from './providers/payments/CashOfficePaymentProvider.js';
import { ManualPaymentDesk } from './services/ManualPaymentDesk.js';
import { StaffAuthService } from './services/StaffAuthService.js';
import { AlertService } from './services/AlertService.js';
import { ETicketService } from './services/ETicketService.js';
import type { WhatsAppTemplateSender } from './services/notifications/NotificationService.js';
import { ReportService } from './services/ReportService.js';
import { createAlertingLogger } from './lib/alertingLogger.js';
import { createStripeClient, StripePaymentProvider, type StripeClientLike } from './providers/payments/StripePaymentProvider.js';
import { StripeWebhookHandler, type StripeWebhookVerifier } from './providers/payments/StripeWebhookHandler.js';
import { createMemoryRepositories } from './repositories/memory.js';
import { createDb } from './repositories/prisma/client.js';
import { createPrismaRepositories } from './repositories/prisma/repositories.js';
import type { Repositories, SessionRepository } from './repositories/types.js';
import { BookingService } from './services/BookingService.js';
import { ConfirmationService } from './services/ConfirmationService.js';
import { FlightSearchService } from './services/FlightSearchService.js';
import { PaymentService } from './services/PaymentService.js';
import { ReconciliationService } from './services/ReconciliationService.js';
import { TravelInfoService } from './services/TravelInfoService.js';
import { randomBytes } from 'node:crypto';
import { WhatsAppSender } from './providers/channels/whatsapp.js';
import { SmsChannelSender } from './providers/channels/twilio.js';
import { LogEmailSender, LogSmsSender, ResendEmailSender, TwilioSmsSender, type EmailSender, type SmsSender } from './providers/notify/senders.js';
import { AuthService } from './services/AuthService.js';
import { ChannelService, type ChannelSender } from './services/ChannelService.js';
import { NotificationService } from './services/notifications/NotificationService.js';
import { SupportService } from './services/SupportService.js';

export interface Container {
  config: AppConfig;
  log: Logger;
  clock: Clock;
  /** 'postgres' when DATABASE_URL is set, otherwise 'memory' (development only). */
  storage: 'postgres' | 'memory';
  repos: Repositories;
  sessions: SessionRepository;
  search: FlightSearchService;
  bookings: BookingService;
  payments: PaymentService;
  /** Staff confirmation of bank and cash payments, and bank statement matching. */
  manualPayments: ManualPaymentDesk;
  /** Support desk staff accounts and sessions. */
  staff: StaffAuthService;
  /** Operations alerts raised from critical log events. */
  alerts: AlertService;
  /** Printable e-ticket PDFs and their signed links. */
  etickets: ETicketService;
  /** Finance CSV exports. */
  reports: ReportService;
  confirmations: ConfirmationService;
  reconciliation: ReconciliationService;
  fx: FxService;
  /** True when MTN MoMo is configured (its callback route is registered). */
  momoEnabled: boolean;
  /** DPO card payments are configured (return/notification endpoint is mounted). */
  dpoEnabled: boolean;
  /** Background jobs; started by the server, not by the container. */
  scheduler: JobScheduler;
  /** Null when no LLM is configured; the chat route then reports 503. */
  agent: BluckFliesAgent | null;
  /** Which model answers: the Anthropic API, the scripted demo (testing only), or none. */
  agentMode: 'anthropic' | 'demo' | 'unconfigured';
  /** Rate limits shared by all servers (database), with a per-server fallback. */
  limits: RateLimiter;
  /** Null when Stripe is not configured; card payments then use the sandbox. */
  stripeWebhooks: StripeWebhookHandler | null;
  /** Null unless Duffel and its webhook secret are configured. */
  duffelWebhooks: DuffelWebhookHandler | null;
  /** Names the flight inventory in use, e.g. "duffel+sandbox-domestic". */
  flightInventory: string;
  cardProvider: string;
  notifications: NotificationService;
  support: SupportService;
  auth: AuthService;
  /** WhatsApp/SMS front-end; null without an LLM. */
  channels: ChannelService | null;
  whatsapp: { sender: ChannelSender; appSecret: string; verifyToken: string } | null;
  smsChannel: { sender: ChannelSender; authToken: string } | null;
  /** Development log senders, exposed so tests and demos can read what was "sent". */
  devOutbox: { email?: LogEmailSender; sms?: LogSmsSender };
}

export interface Overrides {
  clock?: Clock;
  llm?: LlmClient;
  flights?: FlightProvider;
  /** Replaces the mobile-money providers (MTN MoMo and Zain m-Gurush). */
  paymentProvider?: PaymentProvider;
  /** Fake network for the DPO card provider in tests; requires DPO config values. */
  dpoFetch?: typeof fetch;
  /** Fake Stripe client + verifier for tests; requires Stripe config values. */
  stripe?: { client: StripeClientLike; webhooks: StripeWebhookVerifier };
  /** Pre-built repositories (tests run the suite against Postgres this way). */
  repositories?: Repositories;
  /** Fake senders for tests. */
  email?: EmailSender;
  sms?: SmsSender;
  whatsappSender?: ChannelSender;
  /** Fake WhatsApp template sender for tests. */
  whatsappTemplates?: WhatsAppTemplateSender;
}

function buildRepositories(config: AppConfig, log: Logger): { repos: Repositories; storage: Container['storage'] } {
  if (!config.DATABASE_URL) return { repos: createMemoryRepositories(), storage: 'memory' };
  if (!config.DATA_ENCRYPTION_KEYS) throw new Error('DATA_ENCRYPTION_KEYS is required with DATABASE_URL');
  const cipher = new AesGcmFieldCipher(parseKeyring(config.DATA_ENCRYPTION_KEYS));
  const db = createDb({ url: config.DATABASE_URL, poolMax: config.DATABASE_POOL_MAX }, log);
  return { repos: createPrismaRepositories(db, cipher), storage: 'postgres' };
}

function buildFlights(config: AppConfig, log: Logger): FlightProvider {
  if (config.FLIGHT_PROVIDER === 'sandbox') return new SandboxFlightProvider();
  if (!config.DUFFEL_ACCESS_TOKEN) throw new Error('DUFFEL_ACCESS_TOKEN is required with FLIGHT_PROVIDER=duffel');
  const client = new DuffelClient({ accessToken: config.DUFFEL_ACCESS_TOKEN, baseUrl: config.DUFFEL_API_URL.replace(/\/+$/, ''), timeoutMs: 30_000, log });
  const duffel = new DuffelFlightProvider(client, { log, ...(config.DUFFEL_AIRLINES ? { airlines: config.DUFFEL_AIRLINES.split(',') } : {}) });
  return new RoutedFlightProvider(duffel, config.SANDBOX_DOMESTIC_FLIGHTS ? new SandboxFlightProvider() : undefined);
}

function buildMomo(config: AppConfig, clock: Clock, log: Logger): MomoPaymentProvider | undefined {
  const { MOMO_TARGET_ENVIRONMENT: env, MOMO_COLLECTION_SUBSCRIPTION_KEY: sub, MOMO_COLLECTION_API_USER: user, MOMO_COLLECTION_API_KEY: key } = config;
  if (!env || !sub || !user || !key) return undefined;
  const d = config;
  const disbursement =
    d.MOMO_DISBURSEMENT_SUBSCRIPTION_KEY && d.MOMO_DISBURSEMENT_API_USER && d.MOMO_DISBURSEMENT_API_KEY
      ? { subscriptionKey: d.MOMO_DISBURSEMENT_SUBSCRIPTION_KEY, apiUser: d.MOMO_DISBURSEMENT_API_USER, apiKey: d.MOMO_DISBURSEMENT_API_KEY }
      : undefined;
  const client = new MomoClient({
    baseUrl: config.MOMO_BASE_URL.replace(/\/+$/, ''),
    targetEnvironment: env,
    collection: { subscriptionKey: sub, apiUser: user, apiKey: key },
    ...(disbursement ? { disbursement } : {}),
    timeoutMs: 20_000,
    clock,
    log,
  });
  return new MomoPaymentProvider(client, {
    currency: config.MOMO_CURRENCY,
    log,
    // MTN only calls back to HTTPS hosts registered with the API user.
    ...(config.PUBLIC_BASE_URL.startsWith('https://') ? { callbackUrl: `${config.PUBLIC_BASE_URL}/api/webhooks/momo` } : {}),
  });
}

/** Composition root: the only place that knows concrete implementations. */
export function buildContainer(config: AppConfig, baseLog: Logger, overrides: Overrides = {}): Container {
  // Every service logs through this; critical error events also raise alerts (attached below).
  const log = createAlertingLogger(baseLog);
  const clock = overrides.clock ?? systemClock;
  const flights = overrides.flights ?? buildFlights(config, log);
  const prod = config.NODE_ENV === 'production';
  // Sandbox payments exist only outside production; in production a method
  // without a real provider is simply unavailable.
  const sandboxMobile = prod ? undefined : new SandboxPaymentProvider({ name: 'sandbox', chargeCurrency: 'SSP' });
  const momo = buildMomo(config, clock, log);
  const { repos, storage } = overrides.repositories
    ? { repos: overrides.repositories, storage: config.DATABASE_URL ? ('postgres' as const) : ('memory' as const) }
    : buildRepositories(config, log);

  let card: PaymentProvider | undefined = prod ? undefined : new SandboxPaymentProvider({ name: 'sandbox_card', chargeCurrency: 'USD' });
  let stripe: PaymentProvider | undefined;
  let stripeVerifier: StripeWebhookVerifier | null = null;
  if (config.STRIPE_SECRET_KEY && config.STRIPE_WEBHOOK_SECRET) {
    let client: StripeClientLike;
    if (overrides.stripe) {
      client = overrides.stripe.client;
      stripeVerifier = overrides.stripe.webhooks;
    } else {
      const real = createStripeClient(config.STRIPE_SECRET_KEY);
      client = real;
      stripeVerifier = real.webhooks;
    }
    stripe = new StripePaymentProvider(client, clock, config.PUBLIC_BASE_URL);
  }
  // Bank cards: DPO (cards from South Sudanese and other banks) or Stripe; CARD_PROVIDER decides when both are set.
  const dpo =
    config.DPO_COMPANY_TOKEN && config.DPO_SERVICE_TYPE
      ? new DpoPaymentProvider(
          new DpoClient({ baseUrl: config.DPO_API_URL, companyToken: config.DPO_COMPANY_TOKEN, timeoutMs: 20_000, ...(overrides.dpoFetch ? { fetchImpl: overrides.dpoFetch } : {}) }),
          clock,
          { serviceType: config.DPO_SERVICE_TYPE, publicBaseUrl: config.PUBLIC_BASE_URL, autoRefunds: config.DPO_AUTO_REFUNDS },
        )
      : undefined;
  if (config.CARD_PROVIDER === 'stripe') card = stripe ?? card;
  else card = dpo ?? stripe ?? card;
  // Bank transfer / branch deposit, confirmed by staff. Demo account details outside production.
  const bankTransfer =
    config.BANK_NAME && config.BANK_ACCOUNT_NAME && config.BANK_ACCOUNT_NUMBER
      ? new BankTransferPaymentProvider({
          bankName: config.BANK_NAME,
          accountName: config.BANK_ACCOUNT_NAME,
          accountNumber: config.BANK_ACCOUNT_NUMBER,
          ...(config.BANK_BRANCH ? { branch: config.BANK_BRANCH } : {}),
          ...(config.BANK_SWIFT ? { swift: config.BANK_SWIFT } : {}),
        })
      : prod
        ? undefined
        : new BankTransferPaymentProvider(DEMO_BANK_ACCOUNT, { demo: true });
  const mtnMomo = overrides.paymentProvider ?? momo ?? sandboxMobile;
  const zain = overrides.paymentProvider ?? sandboxMobile; // no public m-Gurush merchant API found
  // Cash at an office or partner agent, confirmed by staff. Demo office outside production.
  const cashOffice = config.CASH_OFFICES
    ? new CashOfficePaymentProvider(parseCashOffices(config.CASH_OFFICES))
    : prod
      ? undefined
      : new CashOfficePaymentProvider(DEMO_CASH_OFFICES, { demo: true });
  const gateway = new PaymentGateway(
    {
      ...(card ? { card } : {}),
      ...(bankTransfer ? { bank_transfer: bankTransfer } : {}),
      ...(cashOffice ? { cash_office: cashOffice } : {}),
      ...(mtnMomo ? { mtn_momo: mtnMomo } : {}),
      ...(zain ? { zain_mgurush: zain } : {}),
    },
    // Configured but not the active card provider: still reachable by name, so
    // refunds and webhooks for its earlier payments keep working.
    [stripe, dpo].filter((p): p is PaymentProvider => p !== undefined),
  );

  const fx = new FxService(repos.fx, clock, log, {
    ...(config.SSP_PER_USD && config.SSP_RATE_AS_OF
      ? { bootstrap: { currency: 'SSP', perUsd: config.SSP_PER_USD, asOf: new Date(config.SSP_RATE_AS_OF).toISOString(), source: config.SSP_RATE_SOURCE } }
      : {}),
    maxAgeHours: config.FX_MAX_AGE_HOURS,
    markupBps: config.FX_MARKUP_BPS,
  });
  // Outbound messaging. Development falls back to senders that only log, so
  // login codes and e-tickets can be seen in the server output.
  const devOutbox: Container['devOutbox'] = {};
  let email: EmailSender | undefined = overrides.email;
  if (!email && config.RESEND_API_KEY && config.EMAIL_FROM) email = new ResendEmailSender({ apiKey: config.RESEND_API_KEY, from: config.EMAIL_FROM });
  if (!email && !prod) email = devOutbox.email = new LogEmailSender(log);
  let sms: SmsSender | undefined = overrides.sms;
  if (!sms && config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN && config.TWILIO_FROM) {
    sms = new TwilioSmsSender({ accountSid: config.TWILIO_ACCOUNT_SID, authToken: config.TWILIO_AUTH_TOKEN, from: config.TWILIO_FROM });
  }
  if (!sms && !prod) sms = devOutbox.sms = new LogSmsSender(log);
  // Production requires AUTH_SECRET (see config). In development a per-process secret is fine.
  const authSecret = config.AUTH_SECRET ?? randomBytes(32).toString('hex');

  // Printable e-tickets behind signed links (AUTH_SECRET signs them; links survive restarts only with a fixed secret).
  const etickets = new ETicketService(authSecret, config.PUBLIC_BASE_URL, clock);
  // WhatsApp Cloud API: conversation replies (ChannelService) and booking-message templates.
  const whatsappApi =
    config.WHATSAPP_ACCESS_TOKEN && config.WHATSAPP_PHONE_NUMBER_ID
      ? new WhatsAppSender({ accessToken: config.WHATSAPP_ACCESS_TOKEN, phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID, apiVersion: config.WHATSAPP_API_VERSION, ...(config.WHATSAPP_APP_SECRET ? { appSecret: config.WHATSAPP_APP_SECRET } : {}) }, log)
      : undefined;
  const whatsappTemplates = config.WHATSAPP_TEMPLATE_HELD || config.WHATSAPP_TEMPLATE_TICKETED || config.WHATSAPP_TEMPLATE_REFUNDED
    ? {
        ...(config.WHATSAPP_TEMPLATE_HELD ? { held: config.WHATSAPP_TEMPLATE_HELD } : {}),
        ...(config.WHATSAPP_TEMPLATE_TICKETED ? { ticketed: config.WHATSAPP_TEMPLATE_TICKETED } : {}),
        ...(config.WHATSAPP_TEMPLATE_REFUNDED ? { refunded: config.WHATSAPP_TEMPLATE_REFUNDED } : {}),
        languages: { en: config.WHATSAPP_TEMPLATE_LANG_EN, ar: config.WHATSAPP_TEMPLATE_LANG_AR },
      }
    : undefined;
  /** The WhatsApp number behind a booking made on WhatsApp (the sender, verified by Meta). */
  const whatsappRecipient = async (b: Booking): Promise<string | undefined> => {
    const session = await repos.sessions.findById(b.ownerSessionId);
    if (session?.channel !== 'whatsapp' || !session.travellerId) return undefined;
    return (await repos.travellers.findById(session.travellerId))?.phone;
  };
  const templateSender = overrides.whatsappTemplates ?? whatsappApi;
  const notifications = new NotificationService(repos.notifications, repos.bookings, { email, sms, ...(templateSender ? { whatsapp: templateSender } : {}) }, clock, log, {
    ...(whatsappTemplates ? { whatsappTemplates, whatsappRecipient } : {}),
    siteUrl: config.PUBLIC_BASE_URL,
    eticketLink: (id) => etickets.link(id),
    supportAlertEmails: config.SUPPORT_ALERT_EMAILS,
    supportAlertPhones: config.SUPPORT_ALERT_PHONES,
  });
  const support = new SupportService(repos.tickets, repos.bookings, repos.sessions, repos.travellers, repos.conversations, notifications, clock, log);
  const alerts = new AlertService(notifications, support, repos.bookings, repos.events, clock, log, {
    emails: config.OPS_ALERT_EMAILS.length ? config.OPS_ALERT_EMAILS : config.SUPPORT_ALERT_EMAILS,
    phones: config.OPS_ALERT_PHONES.length ? config.OPS_ALERT_PHONES : config.SUPPORT_ALERT_PHONES,
  });
  log.attach(alerts.onLog);
  const auth = new AuthService(sms, repos.otp, repos.travellers, repos.sessions, repos.bookings, clock, log, authSecret);
  const search = new FlightSearchService(flights, repos.offers, clock, { offerTtlMinutes: config.OFFER_TTL_MINUTES }, fx);
  const payments = new PaymentService(gateway, flights, repos.payments, repos.bookings, repos.events, clock, log, config.PAYMENT_WEBHOOK_SECRET, fx, support, notifications, {
    manualPaymentMinMinutes: config.MANUAL_PAYMENT_MIN_MINUTES,
  });
  const staff = new StaffAuthService(repos.staff, clock, log, { require2fa: config.STAFF_REQUIRE_2FA ? config.STAFF_REQUIRE_2FA === 'true' : prod });
  const manualPayments = new ManualPaymentDesk(payments, support, gateway, repos.payments, repos.bookings, repos.tickets, clock, log);
  const bookings = new BookingService(flights, repos.bookings, search, payments, clock, log, { holdTtlMinutes: config.HOLD_TTL_MINUTES }, repos.sessions, notifications, (id) => etickets.link(id));
  const confirmations = new ConfirmationService(repos.confirmations, bookings, clock);
  const reconciliation = new ReconciliationService(gateway, payments, repos.payments, repos.bookings, clock, log, {
    providers: gateway.providerNames(),
    staleAfterMinutes: config.RECONCILE_AFTER_MINUTES,
    stuckTicketingAfterMinutes: 5,
  });
  const scheduler = new JobScheduler(
    buildJobs({ repos, bookings, reconciliation, notifications, clock, retentionDays: config.DATA_RETENTION_DAYS, pollPayments: gateway.pollingProviders().length > 0 }),
    repos.leases,
    clock,
    log,
  );

  const executor = new ToolExecutor({
    search,
    bookings,
    payments,
    confirmations,
    travelInfo: new TravelInfoService(),
    support,
    flights,
    fx,
    log,
  });

  // A real key always wins; the scripted demo is only for testing before one exists (refused in production).
  const agentMode: Container['agentMode'] = overrides.llm || config.ANTHROPIC_API_KEY ? 'anthropic' : config.AGENT_DEMO ? 'demo' : 'unconfigured';
  if (agentMode === 'demo') log.warn('agent.demo_mode', { note: 'AGENT_DEMO=true: scripted stand-in, not AI. Testing only.' });
  const llm =
    overrides.llm ??
    (config.ANTHROPIC_API_KEY ? new AnthropicLlmClient(config.ANTHROPIC_API_KEY, config.ANTHROPIC_MODEL) : agentMode === 'demo' ? new DemoLlmClient(clock) : null);
  const agentPrices = configuredPrices(config);
  const agentBudget = new AgentBudget(repos.agentUsage, clock, log, {
    dailyUsd: config.AGENT_DAILY_BUDGET_USD,
    conversationUsd: config.AGENT_CONVERSATION_BUDGET_USD,
    prices: agentPrices.prices,
  });
  const agent = llm
    ? new BluckFliesAgent(llm, executor, repos.conversations, clock, log, {
        maxToolIterations: config.AGENT_MAX_TOOL_ITERATIONS,
        sandbox: flights.isSandbox,
        budget: agentBudget,
      })
    : null;

  const limits = new RateLimiter(repos.rateLimits, clock, log);
  const channels = agent ? new ChannelService(agent, confirmations, repos.sessions, auth, repos.events, clock, log, authSecret, limits, support) : null;
  const whatsappSender = overrides.whatsappSender ?? whatsappApi;
  const whatsapp =
    whatsappSender && config.WHATSAPP_APP_SECRET && config.WHATSAPP_VERIFY_TOKEN
      ? { sender: whatsappSender, appSecret: config.WHATSAPP_APP_SECRET, verifyToken: config.WHATSAPP_VERIFY_TOKEN }
      : null;
  const smsChannel = config.SMS_CHANNEL_ENABLED && sms && config.TWILIO_AUTH_TOKEN ? { sender: new SmsChannelSender(sms), authToken: config.TWILIO_AUTH_TOKEN } : null;

  const stripeWebhooks =
    stripeVerifier && config.STRIPE_WEBHOOK_SECRET
      ? new StripeWebhookHandler(stripeVerifier, config.STRIPE_WEBHOOK_SECRET, payments, log, !/_live_/.test(config.STRIPE_SECRET_KEY ?? ''))
      : null;

  return {
    config,
    log,
    clock,
    storage,
    repos,
    sessions: repos.sessions,
    search,
    bookings,
    payments,
    manualPayments,
    staff,
    alerts,
    etickets,
    reports: new ReportService(repos.payments, repos.bookings, clock, repos.agentUsage),
    confirmations,
    reconciliation,
    fx,
    momoEnabled: Boolean(momo) && !overrides.paymentProvider,
    dpoEnabled: Boolean(dpo),
    scheduler,
    agent,
    agentMode,
    limits,
    stripeWebhooks,
    duffelWebhooks:
      config.FLIGHT_PROVIDER === 'duffel' && config.DUFFEL_WEBHOOK_SECRET
        ? new DuffelWebhookHandler(config.DUFFEL_WEBHOOK_SECRET, repos.bookings, repos.events, support, clock, log)
        : null,
    flightInventory:
      config.FLIGHT_PROVIDER === 'sandbox' ? 'sandbox' : config.SANDBOX_DOMESTIC_FLIGHTS ? 'duffel+sandbox-domestic' : 'duffel',
    cardProvider: card?.name ?? 'unavailable',
    notifications,
    support,
    auth,
    channels,
    whatsapp,
    smsChannel,
    devOutbox,
  };
}
