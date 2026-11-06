import { z } from 'zod';
import { parseCashOffices } from '../providers/payments/CashOfficePaymentProvider.js';

/**
 * Validated application configuration. The process refuses to start when a
 * required value is missing or malformed, rather than failing later at runtime.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /**
   * Reverse proxies / load balancers in front of the app that add X-Forwarded-For.
   * Rate limits per address depend on it: too low and every visitor shares the
   * proxy's address; too high and visitors can fake their address.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),

  /**
   * Shared secret a front proxy (e.g. Vercel) adds to every request as the
   * x-origin-secret header. When set, any request without it is refused, so
   * the server answers only through that proxy (health checks excepted).
   */
  ORIGIN_SECRET: z.string().min(32, 'ORIGIN_SECRET must be at least 32 characters').optional(),

  /** Optional: without it the chat endpoint reports the agent as unavailable. */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  /**
   * Testing before an Anthropic key exists: a scripted demo assistant (not AI)
   * that searches flights and hands requests to the desk. Ignored when
   * ANTHROPIC_API_KEY is set; refused in production.
   */
  AGENT_DEMO: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-sonnet-5-5'),
  AGENT_MAX_TOOL_ITERATIONS: z.coerce.number().int().min(1).max(20).default(8),
  /**
   * Spending limits for the AI assistant, in USD, per Juba day. When the whole
   * service reaches the daily budget, the assistant pauses until midnight
   * (travellers keep the step-by-step search and "call me"). One conversation
   * stops using the AI after its own budget for the day (abuse, loops).
   */
  AGENT_DAILY_BUDGET_USD: z.coerce.number().positive().max(100_000).default(20),
  AGENT_CONVERSATION_BUDGET_USD: z.coerce.number().positive().max(1_000).default(0.5),
  /** USD per million tokens; only needed when Anthropic's prices differ from src/agent/pricing.ts. */
  AGENT_PRICE_INPUT_PER_MTOK: z.coerce.number().positive().max(1_000).optional(),
  AGENT_PRICE_OUTPUT_PER_MTOK: z.coerce.number().positive().max(1_000).optional(),
  AGENT_PRICE_CACHE_WRITE_PER_MTOK: z.coerce.number().positive().max(1_000).optional(),
  AGENT_PRICE_CACHE_READ_PER_MTOK: z.coerce.number().positive().max(1_000).optional(),

  /** PostgreSQL connection for the app's runtime role. Without it, data is kept in memory (dev only). */
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'DATABASE_URL must be a postgresql:// URL')
    .optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  /**
   * Keyring for column encryption: "<id>:<base64 32-byte key>[,<id>:<key>…]".
   * The first key encrypts; all keys decrypt (for rotation). Required with DATABASE_URL.
   */
  DATA_ENCRYPTION_KEYS: z.string().min(1).optional(),

  /** Background jobs (hold sweeper, reconciliation, cleanup) in this process. */
  JOBS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Days to keep chat transcripts, idle sessions and webhook dedupe records. */
  DATA_RETENTION_DAYS: z.coerce.number().int().min(7).max(365).default(30),
  /** Minutes before an unconfirmed payment or refund is checked directly with the provider. */
  RECONCILE_AFTER_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(15),

  /** HMAC secret for the mobile-money / sandbox payment webhook format. */
  PAYMENT_WEBHOOK_SECRET: z.string().min(32, 'PAYMENT_WEBHOOK_SECRET must be at least 32 characters'),

  /** Stripe (card payments). Both must be set together; omit both to use sandbox cards. */
  STRIPE_SECRET_KEY: z
    .string()
    .regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/, 'STRIPE_SECRET_KEY must be a Stripe secret (sk_) or restricted (rk_) key')
    .optional(),
  STRIPE_WEBHOOK_SECRET: z.string().regex(/^whsec_[A-Za-z0-9]+$/, 'STRIPE_WEBHOOK_SECRET must start with whsec_').optional(),
  /**
   * DPO Pay (Network International): bank cards, including Visa/Mastercard
   * cards from South Sudanese banks. Token and service type come from DPO.
   */
  DPO_COMPANY_TOKEN: z.string().regex(/^[A-Za-z0-9-]{16,64}$/, 'DPO_COMPANY_TOKEN must be the company token DPO issued').optional(),
  DPO_SERVICE_TYPE: z.string().regex(/^\d{1,10}$/, 'DPO_SERVICE_TYPE must be the numeric service type ID from DPO').optional(),
  DPO_API_URL: z
    .url()
    .default('https://secure.3gdirectpay.com')
    .transform((u) => u.replace(/\/+$/, '')),
  /** Refund through DPO's API. Off = staff refund in the DPO portal from a support ticket. */
  DPO_AUTO_REFUNDS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Which card provider to use when both Stripe and DPO are configured. */
  CARD_PROVIDER: z.enum(['stripe', 'dpo']).optional(),

  /** Bank transfer / branch deposit (USD). Name, account name and number together. */
  BANK_NAME: z.string().max(120).optional(),
  BANK_ACCOUNT_NAME: z.string().max(120).optional(),
  BANK_ACCOUNT_NUMBER: z.string().regex(/^[A-Za-z0-9 -]{4,40}$/, 'BANK_ACCOUNT_NUMBER may contain letters, digits, spaces and dashes').optional(),
  BANK_BRANCH: z.string().max(120).optional(),
  /** Offices and partner agents that take cash: "name | address | hours; name | address | hours". */
  CASH_OFFICES: z.string().max(4000).optional(),
  /** Staff must use two-step login (authenticator app). Default: on in production, off otherwise. */
  STAFF_REQUIRE_2FA: z.enum(['true', 'false']).optional(),
  /** Bank and cash payments are only offered with at least this many minutes left on the seat hold. */
  MANUAL_PAYMENT_MIN_MINUTES: z.coerce.number().int().min(10).max(24 * 60).default(45),
  BANK_SWIFT: z.string().regex(/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/, 'BANK_SWIFT must be an 8 or 11 character SWIFT/BIC code').optional(),

  /** Public origin of this app, used for Stripe Checkout return URLs. */
  PUBLIC_BASE_URL: z
    .url()
    .default('http://localhost:3000')
    .transform((u) => u.replace(/\/+$/, '')),

  /** Flight inventory: generated demo flights, or Duffel (real airlines). */
  FLIGHT_PROVIDER: z.enum(['sandbox', 'duffel']).default('sandbox'),
  DUFFEL_ACCESS_TOKEN: z
    .string()
    .regex(/^duffel_(test|live)_[A-Za-z0-9_-]+$/, 'DUFFEL_ACCESS_TOKEN must be a duffel_test_ or duffel_live_ token')
    .optional(),
  DUFFEL_API_URL: z.url().default('https://api.duffel.com'),
  /** Secret of the Duffel webhook endpoint (airline schedule changes). */
  DUFFEL_WEBHOOK_SECRET: z.string().min(16).optional(),
  /** Optional comma-separated airline IATA codes to sell, e.g. "ET,KQ,MS,TK,FZ". Blank = all. */
  DUFFEL_AIRLINES: z
    .string()
    .regex(/^[A-Z0-9]{2}(,[A-Z0-9]{2})*$/, 'DUFFEL_AIRLINES must be comma-separated 2-character IATA codes')
    .optional(),
  /** Serve routes within South Sudan from the sandbox (development only). */
  SANDBOX_DOMESTIC_FLIGHTS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  /**
   * Starting SSP-per-USD rate and the date it was published. Operators keep
   * the rate current through the admin API; without a current rate, mobile
   * money (charged in SSP) is paused. No default: a stale guess is worse.
   */
  SSP_PER_USD: z.string().regex(/^\d{1,9}(\.\d{1,6})?$/, 'SSP_PER_USD must be a decimal like 4612.5').optional(),
  SSP_RATE_AS_OF: z.iso.datetime({ offset: true }).optional(),
  SSP_RATE_SOURCE: z.string().min(3).default('configuration'),
  /** Mobile-money charges are refused when the newest rate is older than this. */
  FX_MAX_AGE_HOURS: z.coerce.number().int().min(1).max(24 * 7).default(36),
  /** Markup on the exchange rate for SSP charges, in basis points (100 = 1%). */
  FX_MARKUP_BPS: z.coerce.number().int().min(0).max(2_000).default(0),

  /** Bearer token for /api/admin (exchange rates). Unset = admin API disabled. */
  ADMIN_API_TOKEN: z.string().min(32, 'ADMIN_API_TOKEN must be at least 32 characters').optional(),

  /** MTN MoMo Collection API. Unset = MTN MoMo uses the sandbox (development only). */
  MOMO_BASE_URL: z.url().default('https://proxy.momoapi.mtn.com'),
  MOMO_TARGET_ENVIRONMENT: z.string().regex(/^[a-z0-9]+$/, 'MOMO_TARGET_ENVIRONMENT is the lowercase value MTN gives you, e.g. "sandbox"').optional(),
  MOMO_CURRENCY: z.string().regex(/^[A-Z]{3}$/).default('SSP'),
  MOMO_COLLECTION_SUBSCRIPTION_KEY: z.string().min(16).optional(),
  MOMO_COLLECTION_API_USER: z.uuid().optional(),
  MOMO_COLLECTION_API_KEY: z.string().min(16).optional(),
  /** Disbursement product (for automatic refunds). Unset = MoMo refunds go to a person. */
  MOMO_DISBURSEMENT_SUBSCRIPTION_KEY: z.string().min(16).optional(),
  MOMO_DISBURSEMENT_API_USER: z.uuid().optional(),
  MOMO_DISBURSEMENT_API_KEY: z.string().min(16).optional(),

  /**
   * Secret for keyed hashes (phone lookups, login codes, WhatsApp/SMS session keys).
   * Required in production. Changing it signs everyone out of phone login.
   */
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters').optional(),

  /** Email (e-tickets, staff alerts) via Resend. Both together; unset = emails are only logged (development). */
  RESEND_API_KEY: z.string().regex(/^re_[A-Za-z0-9_]+$/, 'RESEND_API_KEY must start with re_').optional(),
  EMAIL_FROM: z.string().min(3).optional(),

  /** SMS (login codes, e-ticket SMS, SMS channel) via Twilio. All three together. */
  TWILIO_ACCOUNT_SID: z.string().regex(/^AC[a-f0-9]{32}$/, 'TWILIO_ACCOUNT_SID must look like AC followed by 32 hex characters').optional(),
  TWILIO_AUTH_TOKEN: z.string().min(16).optional(),
  /** Sender: an E.164 number or a Twilio Messaging Service SID (MG…). */
  TWILIO_FROM: z.string().regex(/^(\+[1-9]\d{7,14}|MG[a-f0-9]{32})$/, 'TWILIO_FROM must be an E.164 number or a Messaging Service SID').optional(),
  /** Let travellers chat with the agent by SMS (needs Twilio). */
  SMS_CHANNEL_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /** WhatsApp Business Cloud API (all four together). */
  WHATSAPP_ACCESS_TOKEN: z.string().min(20).optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().regex(/^\d{5,20}$/, 'WHATSAPP_PHONE_NUMBER_ID is the numeric ID from the WhatsApp Manager').optional(),
  WHATSAPP_APP_SECRET: z.string().min(16).optional(),
  /** Any random string; enter the same value when registering the webhook with Meta. */
  WHATSAPP_VERIFY_TOKEN: z.string().min(16).optional(),
  WHATSAPP_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v21.0'),
  /** Approved message templates for booking messages on WhatsApp (names as in WhatsApp Manager). */
  WHATSAPP_TEMPLATE_HELD: z.string().regex(/^[a-z0-9_]{1,512}$/, 'Template names use lowercase letters, digits and _').optional(),
  WHATSAPP_TEMPLATE_TICKETED: z.string().regex(/^[a-z0-9_]{1,512}$/, 'Template names use lowercase letters, digits and _').optional(),
  WHATSAPP_TEMPLATE_REFUNDED: z.string().regex(/^[a-z0-9_]{1,512}$/, 'Template names use lowercase letters, digits and _').optional(),
  /** Template language codes as approved in WhatsApp Manager (e.g. en, en_US, ar). */
  WHATSAPP_TEMPLATE_LANG_EN: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/).default('en'),
  WHATSAPP_TEMPLATE_LANG_AR: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/).default('ar'),
  /** WhatsApp Business Account ID: lets `npm run connect:check` confirm the templates are approved. */
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().regex(/^\d{5,20}$/).optional(),

  /** Staff alerted about every new support request. Comma-separated. */
  SUPPORT_ALERT_EMAILS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.email('SUPPORT_ALERT_EMAILS must be comma-separated email addresses'))),
  SUPPORT_ALERT_PHONES: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.string().regex(/^\+[1-9]\d{7,14}$/, 'SUPPORT_ALERT_PHONES must be comma-separated E.164 numbers'))),

  /** Who receives operations alerts (paid booking not ticketed, Duffel balance low, AI down…). Default: the support alert lists. */
  OPS_ALERT_EMAILS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.email('OPS_ALERT_EMAILS must be comma-separated email addresses'))),
  OPS_ALERT_PHONES: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.string().regex(/^\+[1-9]\d{7,14}$/, 'OPS_ALERT_PHONES must be comma-separated E.164 numbers'))),

  /** Minutes a fare offer stays valid, and minutes a seat hold lasts before payment. */
  OFFER_TTL_MINUTES: z.coerce.number().int().min(1).max(120).default(30),
  HOLD_TTL_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(60),

  /**
   * Shown on the Terms, Privacy and Refunds pages (/terms, /privacy, /refunds)
   * and in the footer. LEGAL_PAGES_APPROVED=true removes the "draft" banner:
   * set it only after a lawyer has reviewed the pages (docs/LAUNCH.md).
   */
  LEGAL_COMPANY_NAME: z.string().trim().min(2).max(120).optional(),
  LEGAL_COMPANY_ADDRESS: z.string().trim().min(5).max(200).optional(),
  LEGAL_COMPANY_REGISTRATION: z.string().trim().min(2).max(120).optional(),
  SUPPORT_EMAIL: z.email('SUPPORT_EMAIL must be an email address').optional(),
  SUPPORT_PHONE: z.string().regex(/^\+[1-9]\d{7,14}$/, 'SUPPORT_PHONE must be E.164, e.g. +211912345678').optional(),
  LEGAL_PAGES_APPROVED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /** Enables sandbox-only endpoints (simulated payment approval). Never in production. */
  ENABLE_SANDBOX_ENDPOINTS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type AppConfig = z.infer<typeof EnvSchema>;

/** Every setting the app reads (for deployment checks: docker-compose.yml, .env.example). */
export const CONFIG_KEYS: readonly string[] = Object.keys(EnvSchema.shape);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Blank values (`KEY=` in .env, `${KEY:-}` in Compose) mean "not set".
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = EnvSchema.safeParse(present);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const c = parsed.data;
  const prod = c.NODE_ENV === 'production';
  if (prod && c.ENABLE_SANDBOX_ENDPOINTS) {
    throw new Error('Invalid configuration: ENABLE_SANDBOX_ENDPOINTS must be false in production');
  }
  if (prod && c.AGENT_DEMO) {
    throw new Error('Invalid configuration: AGENT_DEMO must be false in production (it is a scripted stand-in, not the AI assistant)');
  }
  if (Boolean(c.DPO_COMPANY_TOKEN) !== Boolean(c.DPO_SERVICE_TYPE)) {
    throw new Error('Invalid configuration: set DPO_COMPANY_TOKEN and DPO_SERVICE_TYPE together');
  }
  if (c.STRIPE_SECRET_KEY && c.DPO_COMPANY_TOKEN && !c.CARD_PROVIDER) {
    throw new Error('Invalid configuration: both Stripe and DPO are configured; set CARD_PROVIDER=stripe or CARD_PROVIDER=dpo');
  }
  if (c.LEGAL_PAGES_APPROVED && !(c.LEGAL_COMPANY_NAME && c.LEGAL_COMPANY_ADDRESS && c.SUPPORT_EMAIL && c.SUPPORT_PHONE)) {
    throw new Error('Invalid configuration: LEGAL_PAGES_APPROVED=true needs LEGAL_COMPANY_NAME, LEGAL_COMPANY_ADDRESS, SUPPORT_EMAIL and SUPPORT_PHONE');
  }
  if (c.AGENT_CONVERSATION_BUDGET_USD > c.AGENT_DAILY_BUDGET_USD) {
    throw new Error('Invalid configuration: AGENT_CONVERSATION_BUDGET_USD cannot be larger than AGENT_DAILY_BUDGET_USD');
  }
  if (Boolean(c.AGENT_PRICE_INPUT_PER_MTOK) !== Boolean(c.AGENT_PRICE_OUTPUT_PER_MTOK)) {
    throw new Error('Invalid configuration: set AGENT_PRICE_INPUT_PER_MTOK and AGENT_PRICE_OUTPUT_PER_MTOK together');
  }
  if (c.CARD_PROVIDER === 'dpo' && !c.DPO_COMPANY_TOKEN) throw new Error('Invalid configuration: CARD_PROVIDER=dpo needs DPO_COMPANY_TOKEN and DPO_SERVICE_TYPE');
  if (c.CARD_PROVIDER === 'stripe' && !c.STRIPE_SECRET_KEY) throw new Error('Invalid configuration: CARD_PROVIDER=stripe needs STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET');
  if (c.CASH_OFFICES) {
    try {
      parseCashOffices(c.CASH_OFFICES);
    } catch (err) {
      throw new Error(`Invalid configuration: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const bank = [c.BANK_NAME, c.BANK_ACCOUNT_NAME, c.BANK_ACCOUNT_NUMBER];
  if (bank.some(Boolean) && !bank.every(Boolean)) {
    throw new Error('Invalid configuration: bank transfers need BANK_NAME, BANK_ACCOUNT_NAME and BANK_ACCOUNT_NUMBER together');
  }
  if (Boolean(c.STRIPE_SECRET_KEY) !== Boolean(c.STRIPE_WEBHOOK_SECRET)) {
    throw new Error('Invalid configuration: set both STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET, or neither');
  }
  if (prod && !c.DATABASE_URL) {
    throw new Error('Invalid configuration: DATABASE_URL is required in production');
  }
  if (c.DATABASE_URL && !c.DATA_ENCRYPTION_KEYS) {
    throw new Error('Invalid configuration: DATA_ENCRYPTION_KEYS is required when DATABASE_URL is set');
  }
  if (prod && !c.PUBLIC_BASE_URL.startsWith('https://')) {
    throw new Error('Invalid configuration: PUBLIC_BASE_URL must use https in production');
  }
  if (c.FLIGHT_PROVIDER === 'duffel' && !c.DUFFEL_ACCESS_TOKEN) {
    throw new Error('Invalid configuration: DUFFEL_ACCESS_TOKEN is required when FLIGHT_PROVIDER=duffel');
  }
  if (prod && c.FLIGHT_PROVIDER === 'sandbox') {
    throw new Error('Invalid configuration: FLIGHT_PROVIDER=sandbox sells generated flights and is not allowed in production');
  }
  if (prod && c.FLIGHT_PROVIDER === 'duffel' && c.SANDBOX_DOMESTIC_FLIGHTS) {
    throw new Error('Invalid configuration: SANDBOX_DOMESTIC_FLIGHTS must be false in production');
  }
  if (prod && c.DUFFEL_ACCESS_TOKEN?.startsWith('duffel_test_')) {
    throw new Error('Invalid configuration: a Duffel test token creates test bookings, not real tickets; use a live token in production');
  }
  if (!prod && c.DUFFEL_ACCESS_TOKEN?.startsWith('duffel_live_')) {
    throw new Error('Invalid configuration: live Duffel tokens are only allowed when NODE_ENV=production');
  }
  if (Boolean(c.SSP_PER_USD) !== Boolean(c.SSP_RATE_AS_OF)) {
    throw new Error('Invalid configuration: set SSP_PER_USD together with SSP_RATE_AS_OF (when the rate was published)');
  }
  const momoCollection = [c.MOMO_TARGET_ENVIRONMENT, c.MOMO_COLLECTION_SUBSCRIPTION_KEY, c.MOMO_COLLECTION_API_USER, c.MOMO_COLLECTION_API_KEY];
  if (momoCollection.some(Boolean) && !momoCollection.every(Boolean)) {
    throw new Error('Invalid configuration: MTN MoMo needs MOMO_TARGET_ENVIRONMENT, MOMO_COLLECTION_SUBSCRIPTION_KEY, MOMO_COLLECTION_API_USER and MOMO_COLLECTION_API_KEY together');
  }
  const momoDisb = [c.MOMO_DISBURSEMENT_SUBSCRIPTION_KEY, c.MOMO_DISBURSEMENT_API_USER, c.MOMO_DISBURSEMENT_API_KEY];
  if (momoDisb.some(Boolean) && !(momoDisb.every(Boolean) && c.MOMO_TARGET_ENVIRONMENT)) {
    throw new Error('Invalid configuration: MTN MoMo refunds need all three MOMO_DISBURSEMENT_* values and the collection settings');
  }
  if (prod && c.MOMO_TARGET_ENVIRONMENT === 'sandbox') {
    throw new Error('Invalid configuration: the MTN MoMo sandbox environment cannot be used in production');
  }
  if (!prod && /_live_/.test(c.STRIPE_SECRET_KEY ?? '')) {
    throw new Error('Invalid configuration: live Stripe keys are only allowed when NODE_ENV=production');
  }
  if (Boolean(c.RESEND_API_KEY) !== Boolean(c.EMAIL_FROM)) {
    throw new Error('Invalid configuration: set RESEND_API_KEY and EMAIL_FROM together');
  }
  const twilio = [c.TWILIO_ACCOUNT_SID, c.TWILIO_AUTH_TOKEN, c.TWILIO_FROM];
  if (twilio.some(Boolean) && !twilio.every(Boolean)) {
    throw new Error('Invalid configuration: set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM together');
  }
  if (c.SMS_CHANNEL_ENABLED && !c.TWILIO_ACCOUNT_SID) {
    throw new Error('Invalid configuration: SMS_CHANNEL_ENABLED needs the TWILIO_* settings');
  }
  const wa = [c.WHATSAPP_ACCESS_TOKEN, c.WHATSAPP_PHONE_NUMBER_ID, c.WHATSAPP_APP_SECRET, c.WHATSAPP_VERIFY_TOKEN];
  if (wa.some(Boolean) && !wa.every(Boolean)) {
    throw new Error('Invalid configuration: set WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET and WHATSAPP_VERIFY_TOKEN together');
  }
  if (prod && !c.AUTH_SECRET) {
    throw new Error('Invalid configuration: AUTH_SECRET is required in production (phone login and WhatsApp/SMS sessions)');
  }
  if (prod && !c.RESEND_API_KEY) {
    throw new Error('Invalid configuration: RESEND_API_KEY and EMAIL_FROM are required in production so travellers receive their e-tickets');
  }
  return c;
}
