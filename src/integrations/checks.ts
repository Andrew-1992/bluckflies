import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configuredPrices } from '../agent/pricing.js';
import { LEGAL_DIR, LEGAL_PAGES } from '../http/legal.js';
import type { AppConfig } from '../config/env.js';
import { parseKeyring } from '../lib/fieldCipher.js';
import { appSecretProof } from '../providers/channels/whatsapp.js';
import { parseFlatXml, xmlEscape } from '../providers/payments/dpo/DpoClient.js';
import { parseCashOffices } from '../providers/payments/CashOfficePaymentProvider.js';

/**
 * Connection checks for every external service BluckFlies is configured to
 * use. Each check makes only read-only calls (it never books, charges, sends
 * or changes anything) and never echoes a secret: details come from the
 * providers' own error messages and from non-secret fields.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'off';

export interface CheckResult {
  service: string;
  status: CheckStatus;
  detail: string;
  /** What to do about a warn or fail. */
  fix?: string;
}

export interface MigrationState {
  /** Names of migrations applied and finished in the database. */
  applied: string[];
}

export interface CheckDeps {
  fetch: typeof fetch;
  timeoutMs: number;
  now: Date;
  /** Names of the migration folders shipped with this version. */
  localMigrations: string[];
  /** Reads applied migrations; throws when the database is unreachable. Returns null if never migrated. */
  readMigrations: (databaseUrl: string) => Promise<MigrationState | null>;
}

interface HttpResult {
  status: number;
  json: unknown;
}

const ANTHROPIC_VERSION = '2023-06-01';

const isLocal = (url: string): boolean => /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(url);

const field = (v: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const basic = (user: string, pass: string): string => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

async function http(deps: CheckDeps, url: string, init: { method?: string; headers: Record<string, string> }): Promise<HttpResult> {
  const res = await deps.fetch(url, { method: init.method ?? 'GET', headers: init.headers, signal: AbortSignal.timeout(deps.timeoutMs) });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

/** Runs a check, turning network errors and surprises into a readable failure. */
async function guarded(
  service: string,
  host: string,
  run: () => Promise<CheckResult | CheckResult[]>,
  fix = 'Check the internet connection, firewall or proxy, then run the check again.',
): Promise<CheckResult[]> {
  try {
    const r = await run();
    return Array.isArray(r) ? r : [r];
  } catch (err) {
    const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : err instanceof Error ? err.message : String(err);
    return [{ service, status: 'fail', detail: `Could not reach ${host}: ${reason}`, fix }];
  }
}

const providerMessage = (json: unknown): string =>
  str(field(json, 'error', 'message')) ??
  str(field(json, 'errors', '0', 'message')) ??
  str(field(json, 'message')) ??
  str(field(json, 'error')) ??
  'no details';

// ------------------------------------------------------------------ Claude

async function checkClaude(c: AppConfig, deps: CheckDeps): Promise<CheckResult[]> {
  const service = 'Claude (AI agent)';
  if (!c.ANTHROPIC_API_KEY) {
    return [{ service, status: 'warn', detail: 'ANTHROPIC_API_KEY is not set: the site runs but chat answers "agent unavailable".', fix: 'Create a key at https://console.anthropic.com (Settings > API keys) and put it in ANTHROPIC_API_KEY.' }];
  }
  const key = c.ANTHROPIC_API_KEY;
  return guarded(service, 'api.anthropic.com', async () => {
    const r = await http(deps, `https://api.anthropic.com/v1/models/${encodeURIComponent(c.ANTHROPIC_MODEL)}`, {
      headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
    });
    if (r.status === 200) {
      const { prices, source } = configuredPrices(c);
      const limits = `Budget $${c.AGENT_DAILY_BUDGET_USD}/day, $${c.AGENT_CONVERSATION_BUDGET_USD} per conversation per day; metered at $${prices.input} input / $${prices.output} output per million tokens`;
      if (source === 'fallback') {
        return { service, status: 'warn', detail: `Key accepted; model ${c.ANTHROPIC_MODEL} is available, but its prices are unknown, so spending is metered at the highest known rates (the budget runs out early). ${limits}.`, fix: 'Set AGENT_PRICE_INPUT_PER_MTOK and AGENT_PRICE_OUTPUT_PER_MTOK from https://platform.claude.com/docs/en/about-claude/pricing.' };
      }
      return { service, status: 'ok', detail: `Key accepted; model ${c.ANTHROPIC_MODEL} is available. ${limits} (${source === 'env' ? 'prices from .env' : 'built-in price list'}).` };
    }
    if (r.status === 401) return { service, status: 'fail', detail: 'The API key was rejected.', fix: 'Copy the key again from https://console.anthropic.com; keys are shown only once when created.' };
    if (r.status === 403) return { service, status: 'fail', detail: `Key not allowed: ${providerMessage(r.json)}`, fix: 'Check the key\'s workspace and that billing is set up in the Anthropic Console.' };
    if (r.status === 404) return { service, status: 'fail', detail: `Model "${c.ANTHROPIC_MODEL}" was not found for this key.`, fix: 'Set ANTHROPIC_MODEL to a current model ID, e.g. claude-sonnet-5-5 or claude-haiku-5-5.' };
    return { service, status: 'fail', detail: `HTTP ${r.status}: ${providerMessage(r.json)}` };
  });
}

// ---------------------------------------------------------------- database

async function checkDatabase(c: AppConfig, deps: CheckDeps): Promise<CheckResult[]> {
  const service = 'PostgreSQL database';
  if (!c.DATABASE_URL) {
    return [{ service, status: c.NODE_ENV === 'production' ? 'fail' : 'warn', detail: 'DATABASE_URL is not set: data is kept in memory and lost on restart.', fix: 'Fine for trying it out. For real use, see "Database" in docs/CONNECT.md.' }];
  }
  const results: CheckResult[] = [];
  try {
    parseKeyring(c.DATA_ENCRYPTION_KEYS ?? '');
  } catch (err) {
    results.push({ service: 'Data encryption keys', status: 'fail', detail: err instanceof Error ? err.message : String(err), fix: 'Generate a key: node -e "console.log(\'k1:\'+require(\'crypto\').randomBytes(32).toString(\'base64\'))"' });
  }
  const url = c.DATABASE_URL;
  const host = (() => {
    try {
      const u = new URL(url);
      return `${u.hostname}:${u.port || '5432'}`;
    } catch {
      return 'the database';
    }
  })();
  results.push(
    ...(await guarded(service, host, async () => {
      const state = await deps.readMigrations(url);
      if (!state) return { service, status: 'fail', detail: `Connected to ${host}, but the database has no tables yet.`, fix: 'Run: npm run db:deploy (with MIGRATION_DATABASE_URL set to the owner role).' };
      const pending = deps.localMigrations.filter((m) => !state.applied.includes(m));
      if (pending.length > 0) return { service, status: 'fail', detail: `Connected to ${host}; ${pending.length} migration(s) not applied: ${pending.join(', ')}.`, fix: 'Run: npm run db:deploy' };
      return { service, status: 'ok', detail: `Connected to ${host}; all ${deps.localMigrations.length} migrations applied.` };
    }, 'Is PostgreSQL running? Check the host, port, user, password and database name in DATABASE_URL.')),
  );
  return results;
}

// ----------------------------------------------------------------- flights

async function checkDuffel(c: AppConfig, deps: CheckDeps): Promise<CheckResult[]> {
  const service = 'Duffel (airline flights)';
  if (!c.DUFFEL_ACCESS_TOKEN) {
    return [{ service, status: 'off', detail: 'FLIGHT_PROVIDER=sandbox: generated demo flights, not real airlines.', fix: 'For real flights, see "Duffel" in docs/CONNECT.md.' }];
  }
  const token = c.DUFFEL_ACCESS_TOKEN;
  const mode = token.startsWith('duffel_live_') ? 'live' : 'test';
  const results = await guarded(service, new URL(c.DUFFEL_API_URL).host, async () => {
    const r = await http(deps, `${c.DUFFEL_API_URL.replace(/\/+$/, '')}/air/airlines?limit=1`, {
      headers: { Authorization: `Bearer ${token}`, 'Duffel-Version': 'v2', Accept: 'application/json' },
    });
    if (r.status === 200) {
      const inUse = c.FLIGHT_PROVIDER === 'duffel';
      return {
        service,
        status: inUse ? 'ok' : 'warn',
        detail: `Token accepted (${mode} mode${mode === 'test' ? ': test bookings, no real tickets' : ''}).${inUse ? '' : ' But FLIGHT_PROVIDER is still sandbox.'}`,
        ...(inUse ? {} : { fix: 'Set FLIGHT_PROVIDER=duffel to search real airlines.' }),
      };
    }
    if (r.status === 401) return { service, status: 'fail', detail: 'The access token was rejected.', fix: 'Create a new token in the Duffel dashboard (Developers > Access tokens).' };
    return { service, status: 'fail', detail: `HTTP ${r.status}: ${providerMessage(r.json)}` };
  });
  if (!c.DUFFEL_WEBHOOK_SECRET) {
    results.push({ service: 'Duffel webhooks', status: 'warn', detail: 'DUFFEL_WEBHOOK_SECRET is not set: airline schedule changes are not received.', fix: `In Duffel, add a webhook to ${c.PUBLIC_BASE_URL}/api/webhooks/duffel and copy its secret here.` });
  }
  return results;
}

// ---------------------------------------------------------------- payments

async function checkStripe(c: AppConfig, deps: CheckDeps): Promise<CheckResult[]> {
  const service = 'Stripe (cards)';
  if (!c.STRIPE_SECRET_KEY) {
    return [{ service, status: c.NODE_ENV === 'production' ? 'warn' : 'off', detail: c.NODE_ENV === 'production' ? 'Not set: card payments are off.' : 'Not set: cards use the sandbox (simulated payments).', fix: 'See "Stripe" in docs/CONNECT.md.' }];
  }
  const key = c.STRIPE_SECRET_KEY;
  const live = /_live_/.test(key);
  // Live keys outside production are already refused by loadConfig.
  return guarded(service, 'api.stripe.com', async () => {
    const r = await http(deps, 'https://api.stripe.com/v1/checkout/sessions?limit=1', { headers: { Authorization: `Bearer ${key}` } });
    if (r.status === 200 && c.DPO_COMPANY_TOKEN && c.CARD_PROVIDER === 'dpo') {
      return { service, status: 'ok', detail: 'Key accepted. Not used for new card payments (CARD_PROVIDER=dpo); kept for refunds of earlier Stripe payments.' };
    }
    if (r.status === 200) {
      const tunnel = isLocal(c.PUBLIC_BASE_URL) ? ' Locally, forward webhooks with: stripe listen --forward-to localhost:' + c.PORT + '/api/webhooks/stripe' : '';
      return { service, status: 'ok', detail: `Key accepted (${live ? 'live' : 'test'} mode); Checkout is reachable.${tunnel}` };
    }
    if (r.status === 401) return { service, status: 'fail', detail: 'The key was rejected.', fix: 'Copy it again from the Stripe Dashboard (Developers > API keys).' };
    if (r.status === 403) return { service, status: 'fail', detail: 'The restricted key lacks permission for Checkout Sessions.', fix: 'Edit the restricted key: give Checkout Sessions and Refunds "Write" access.' };
    return { service, status: 'fail', detail: `HTTP ${r.status}: ${providerMessage(r.json)}` };
  });
}

async function checkDpo(c: AppConfig, deps: CheckDeps): Promise<CheckResult[]> {
  const service = 'DPO Pay (bank cards)';
  if (!c.DPO_COMPANY_TOKEN || !c.DPO_SERVICE_TYPE) {
    return [{ service, status: 'off', detail: 'Not set: bank cards use Stripe if configured, otherwise the sandbox.', fix: 'See "DPO Pay" in docs/CONNECT.md to accept Visa/Mastercard cards from South Sudanese banks.' }];
  }
  const token = c.DPO_COMPANY_TOKEN;
  const active = c.CARD_PROVIDER !== 'stripe';
  return guarded(service, new URL(c.DPO_API_URL).host, async () => {
    // verifyToken on a made-up transaction is read-only: DPO answers 801/802 only when the company token itself is wrong.
    const r = await deps.fetch(`${c.DPO_API_URL}/API/v6/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml; charset=utf-8', Accept: 'application/xml' },
      body: `<?xml version="1.0" encoding="utf-8"?><API3G><CompanyToken>${xmlEscape(token)}</CompanyToken><Request>verifyToken</Request><TransactionToken>00000000-0000-0000-0000-000000000000</TransactionToken></API3G>`,
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    const fields = parseFlatXml(await r.text());
    const result = fields['Result'];
    if (!r.ok || !result) return { service, status: 'fail', detail: `Unexpected answer from DPO (HTTP ${r.status}).`, fix: 'Check DPO_API_URL (normally https://secure.3gdirectpay.com).' };
    if (result === '801' || result === '802') return { service, status: 'fail', detail: 'DPO rejected the company token.', fix: 'Copy the company token again from DPO (it looks like 8-4-4-4-12 characters).' };
    return {
      service,
      status: active ? 'ok' : 'warn',
      detail: `Company token accepted${active ? '' : ', but CARD_PROVIDER=stripe, so DPO is not used for new payments'}. The service type (${c.DPO_SERVICE_TYPE}) is only checked on the first real payment: make one small test payment.${c.DPO_AUTO_REFUNDS ? '' : ' Refunds are made by staff in the DPO portal (DPO_AUTO_REFUNDS=false).'}`,
      ...(active ? {} : { fix: 'Set CARD_PROVIDER=dpo to take cards through DPO.' }),
    };
  });
}

function checkBankTransfer(c: AppConfig): CheckResult[] {
  const service = 'Bank transfer / branch deposit';
  if (!c.BANK_NAME || !c.BANK_ACCOUNT_NAME || !c.BANK_ACCOUNT_NUMBER) {
    return c.NODE_ENV === 'production'
      ? [{ service, status: 'off', detail: 'Not set: travellers cannot pay at a bank.', fix: 'Set BANK_NAME, BANK_ACCOUNT_NAME and BANK_ACCOUNT_NUMBER (see "Bank transfer" in docs/CONNECT.md).' }]
      : [{ service, status: 'warn', detail: 'Using a DEMO bank account (marked as demo to travellers).', fix: 'Set BANK_NAME, BANK_ACCOUNT_NAME and BANK_ACCOUNT_NUMBER to your real USD account.' }];
  }
  const tail = c.BANK_ACCOUNT_NUMBER.replace(/\s/g, '').slice(-4);
  return [{ service, status: 'ok', detail: `${c.BANK_NAME}, account ${c.BANK_ACCOUNT_NAME} ending ${tail}. Staff confirm deposits on the support desk.` }];
}

function checkCashOffices(c: AppConfig): CheckResult[] {
  const service = 'Cash at office / partner agent';
  if (!c.CASH_OFFICES) {
    return c.NODE_ENV === 'production'
      ? [{ service, status: 'off', detail: 'Not set: travellers cannot pay cash at an office.', fix: 'Set CASH_OFFICES (see "Cash at an office" in docs/CONNECT.md).' }]
      : [{ service, status: 'warn', detail: 'Using a DEMO office (marked as demo to travellers).', fix: 'Set CASH_OFFICES to your offices and partner agents.' }];
  }
  const offices = parseCashOffices(c.CASH_OFFICES);
  return [{ service, status: 'ok', detail: `${offices.length} place(s): ${offices.map((o) => o.name).join(', ')}. Offered while at least ${c.MANUAL_PAYMENT_MIN_MINUTES} minutes remain on the seat hold.` }];
}

async function checkMomoProduct(
  c: AppConfig,
  deps: CheckDeps,
  product: 'collection' | 'disbursement',
  creds: { subscriptionKey: string; apiUser: string; apiKey: string },
): Promise<CheckResult[]> {
  const service = `MTN MoMo ${product === 'collection' ? 'payments' : 'refunds'}`;
  const base = c.MOMO_BASE_URL.replace(/\/+$/, '');
  return guarded(service, new URL(base).host, async () => {
    const t = await http(deps, `${base}/${product}/token/`, {
      method: 'POST',
      headers: { Authorization: basic(creds.apiUser, creds.apiKey), 'Ocp-Apim-Subscription-Key': creds.subscriptionKey },
    });
    const token = str(field(t.json, 'access_token'));
    if (t.status !== 200 || !token) {
      if (t.status === 401) return { service, status: 'fail', detail: 'MTN rejected the subscription key or API user/key.', fix: `Check MOMO_${product.toUpperCase()}_SUBSCRIPTION_KEY, _API_USER and _API_KEY (each product has its own).` };
      return { service, status: 'fail', detail: `Token request failed: HTTP ${t.status}: ${providerMessage(t.json)}` };
    }
    const b = await http(deps, `${base}/${product}/v1_0/account/balance`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Target-Environment': c.MOMO_TARGET_ENVIRONMENT ?? '', 'Ocp-Apim-Subscription-Key': creds.subscriptionKey },
    });
    if (b.status === 200) {
      const currency = str(field(b.json, 'currency'));
      if (currency && currency !== c.MOMO_CURRENCY) {
        return { service, status: 'warn', detail: `Connected, but the account currency is ${currency} and MOMO_CURRENCY is ${c.MOMO_CURRENCY}.`, fix: `Set MOMO_CURRENCY=${currency} (the MTN sandbox uses EUR).` };
      }
      return { service, status: 'ok', detail: `Connected to target environment "${c.MOMO_TARGET_ENVIRONMENT ?? ''}"${currency ? ` (${currency})` : ''}.` };
    }
    return { service, status: 'fail', detail: `Credentials work, but the account check failed: HTTP ${b.status}: ${providerMessage(b.json)}`, fix: 'Usually a wrong MOMO_TARGET_ENVIRONMENT: use the exact value MTN gave you.' };
  });
}

async function checkMomo(c: AppConfig, deps: CheckDeps): Promise<CheckResult[]> {
  if (!c.MOMO_COLLECTION_SUBSCRIPTION_KEY || !c.MOMO_COLLECTION_API_USER || !c.MOMO_COLLECTION_API_KEY) {
    return [{ service: 'MTN MoMo payments', status: c.NODE_ENV === 'production' ? 'warn' : 'off', detail: c.NODE_ENV === 'production' ? 'Not set: MTN MoMo payments are off.' : 'Not set: MTN MoMo uses the sandbox (simulated payments).', fix: 'See "MTN MoMo" in docs/CONNECT.md.' }];
  }
  const results = await checkMomoProduct(c, deps, 'collection', { subscriptionKey: c.MOMO_COLLECTION_SUBSCRIPTION_KEY, apiUser: c.MOMO_COLLECTION_API_USER, apiKey: c.MOMO_COLLECTION_API_KEY });
  if (c.MOMO_DISBURSEMENT_SUBSCRIPTION_KEY && c.MOMO_DISBURSEMENT_API_USER && c.MOMO_DISBURSEMENT_API_KEY) {
    results.push(...(await checkMomoProduct(c, deps, 'disbursement', { subscriptionKey: c.MOMO_DISBURSEMENT_SUBSCRIPTION_KEY, apiUser: c.MOMO_DISBURSEMENT_API_USER, apiKey: c.MOMO_DISBURSEMENT_API_KEY })));
  } else {
    results.push({ service: 'MTN MoMo refunds', status: 'warn', detail: 'Disbursement is not set: MoMo refunds become support tickets for staff.', fix: 'Optional. Subscribe to the Disbursement product in the MTN portal to refund automatically.' });
  }
  if (isLocal(c.PUBLIC_BASE_URL)) {
    results.push({ service: 'MTN MoMo callbacks', status: 'warn', detail: 'PUBLIC_BASE_URL is local, so MTN cannot send payment callbacks; BluckFlies asks MTN directly every 20 seconds instead.', fix: 'Deploy to a public https address and set PUBLIC_BASE_URL to it.' });
  }
  return results;
}

function checkFx(c: AppConfig, deps: CheckDeps): CheckResult[] {
  const service = 'SSP exchange rate';
  if (!c.SSP_PER_USD || !c.SSP_RATE_AS_OF) {
    return [{ service, status: 'warn', detail: 'No starting rate: mobile-money (SSP) payments are refused until a rate is posted.', fix: 'Post today\'s rate from the admin API (POST /api/admin/fx-rates), or set SSP_PER_USD and SSP_RATE_AS_OF.' }];
  }
  const ageHours = (deps.now.getTime() - Date.parse(c.SSP_RATE_AS_OF)) / 3_600_000;
  if (!Number.isFinite(ageHours)) return [{ service, status: 'fail', detail: 'SSP_RATE_AS_OF is not a valid date.', fix: 'Use an ISO date and time, e.g. 2026-11-04T08:00:00Z.' }];
  if (ageHours > c.FX_MAX_AGE_HOURS) {
    return [{ service, status: 'warn', detail: `The configured rate is ${Math.floor(ageHours)} hours old (limit ${c.FX_MAX_AGE_HOURS}); SSP payments are refused unless a newer rate was posted.`, fix: 'Post today\'s rate: POST /api/admin/fx-rates.' }];
  }
  return [{ service, status: 'ok', detail: `${c.SSP_PER_USD} SSP per USD, ${Math.floor(ageHours)} hours old.` }];
}

// --------------------------------------------------------------- messaging

async function checkResend(c: AppConfig, deps: CheckDeps): Promise<CheckResult[]> {
  const service = 'Resend (email)';
  if (!c.RESEND_API_KEY) {
    return [{ service, status: c.NODE_ENV === 'production' ? 'fail' : 'off', detail: 'Not set: emails (e-tickets, staff alerts) are only printed in the server log.', fix: 'See "Resend" in docs/CONNECT.md.' }];
  }
  // loadConfig requires EMAIL_FROM together with RESEND_API_KEY.
  const key = c.RESEND_API_KEY;
  const fromDomain = /@([^>\s]+)>?\s*$/.exec(c.EMAIL_FROM ?? '')?.[1]?.toLowerCase();
  return guarded(service, 'api.resend.com', async () => {
    const r = await http(deps, 'https://api.resend.com/domains', { headers: { Authorization: `Bearer ${key}` } });
    if (r.status === 200) {
      const domains = Array.isArray(field(r.json, 'data')) ? (field(r.json, 'data') as unknown[]) : [];
      const match = domains.find((d) => str(field(d, 'name'))?.toLowerCase() === fromDomain);
      if (!match) return { service, status: 'fail', detail: `Key accepted, but ${fromDomain ?? 'the EMAIL_FROM domain'} is not added in Resend.`, fix: 'In Resend > Domains, add the domain and create the DNS records it shows.' };
      const status = str(field(match, 'status'));
      if (status !== 'verified') return { service, status: 'fail', detail: `Key accepted; domain ${fromDomain} is "${status ?? 'unknown'}", not verified.`, fix: 'Add the DNS records Resend shows for the domain, then press Verify.' };
      return { service, status: 'ok', detail: `Key accepted; sending from verified domain ${fromDomain}.` };
    }
    if (r.status === 401 && str(field(r.json, 'name')) === 'restricted_api_key') {
      return { service, status: 'warn', detail: 'Sending-only key: valid, but it cannot list domains to confirm EMAIL_FROM is verified.', fix: `Make sure ${fromDomain ?? 'the sender domain'} shows "Verified" in Resend > Domains.` };
    }
    if (r.status === 401 || r.status === 403) return { service, status: 'fail', detail: `The key was rejected: ${providerMessage(r.json)}`, fix: 'Create a new key in Resend > API Keys.' };
    return { service, status: 'fail', detail: `HTTP ${r.status}: ${providerMessage(r.json)}` };
  });
}

async function checkTwilio(c: AppConfig, deps: CheckDeps): Promise<CheckResult[]> {
  const service = 'Twilio (SMS)';
  if (!c.TWILIO_ACCOUNT_SID || !c.TWILIO_AUTH_TOKEN || !c.TWILIO_FROM) {
    const partial = Boolean(c.TWILIO_ACCOUNT_SID || c.TWILIO_AUTH_TOKEN || c.TWILIO_FROM);
    if (partial) return [{ service, status: 'fail', detail: 'Only some Twilio settings are filled in.', fix: 'Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM together.' }];
    return [{ service, status: c.NODE_ENV === 'production' ? 'warn' : 'off', detail: c.NODE_ENV === 'production' ? 'Not set: phone login and SMS are off.' : 'Not set: SMS and login codes are printed in the server log.', fix: 'See "Twilio" in docs/CONNECT.md.' }];
  }
  const sid = c.TWILIO_ACCOUNT_SID;
  const auth = basic(sid, c.TWILIO_AUTH_TOKEN);
  const from = c.TWILIO_FROM;
  const results = await guarded(service, 'api.twilio.com', async () => {
    const acct = await http(deps, `https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, { headers: { Authorization: auth } });
    if (acct.status === 401) return { service, status: 'fail', detail: 'Account SID or auth token was rejected.', fix: 'Copy both from the Twilio Console home page.' };
    if (acct.status !== 200) return { service, status: 'fail', detail: `HTTP ${acct.status}: ${providerMessage(acct.json)}` };
    const state = str(field(acct.json, 'status'));
    if (state !== 'active') return { service, status: 'fail', detail: `The Twilio account is ${state ?? 'not active'}.`, fix: 'Reactivate the account in the Twilio Console.' };

    const sender = from.startsWith('MG')
      ? await http(deps, `https://messaging.twilio.com/v1/Services/${from}`, { headers: { Authorization: auth } })
      : await http(deps, `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(from)}`, { headers: { Authorization: auth } });
    const senderOk = from.startsWith('MG') ? sender.status === 200 : sender.status === 200 && (field(sender.json, 'incoming_phone_numbers') as unknown[] | undefined)?.length;
    if (!senderOk) return { service, status: 'fail', detail: `Account works, but TWILIO_FROM (${from}) is not a ${from.startsWith('MG') ? 'Messaging Service' : 'phone number'} on this account.`, fix: 'Use a number from Phone Numbers > Active numbers, or a Messaging Service SID (MG…).' };

    if (str(field(acct.json, 'type')) === 'Trial') {
      return { service, status: 'warn', detail: `Connected, sending from ${from}. Trial account: SMS only reach numbers you verified in Twilio.`, fix: 'Upgrade the Twilio account before real travellers use phone login.' };
    }
    return { service, status: 'ok', detail: `Connected; sending from ${from}.` };
  });
  if (c.SMS_CHANNEL_ENABLED && isLocal(c.PUBLIC_BASE_URL)) {
    results.push({ service: 'SMS chat channel', status: 'warn', detail: 'SMS_CHANNEL_ENABLED is on but PUBLIC_BASE_URL is local, so Twilio cannot deliver incoming texts.', fix: `After deploying, set the number's incoming-message webhook to ${c.PUBLIC_BASE_URL}/api/webhooks/sms.` });
  }
  return results;
}

async function checkWhatsApp(c: AppConfig, deps: CheckDeps): Promise<CheckResult[]> {
  const service = 'WhatsApp (Meta)';
  const values = [c.WHATSAPP_ACCESS_TOKEN, c.WHATSAPP_PHONE_NUMBER_ID, c.WHATSAPP_APP_SECRET, c.WHATSAPP_VERIFY_TOKEN];
  if (!values.some(Boolean)) return [{ service, status: 'off', detail: 'Not set: the WhatsApp channel is off.', fix: 'Optional. See "WhatsApp" in docs/CONNECT.md.' }];
  if (!c.WHATSAPP_ACCESS_TOKEN || !c.WHATSAPP_PHONE_NUMBER_ID || !c.WHATSAPP_APP_SECRET || !c.WHATSAPP_VERIFY_TOKEN) {
    return [{ service, status: 'fail', detail: 'Only some WhatsApp settings are filled in.', fix: 'Set all four: WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET and WHATSAPP_VERIFY_TOKEN.' }];
  }
  const token = c.WHATSAPP_ACCESS_TOKEN;
  const proof = appSecretProof(token, c.WHATSAPP_APP_SECRET);
  const results = await guarded(service, 'graph.facebook.com', async () => {
    const url = `https://graph.facebook.com/${c.WHATSAPP_API_VERSION}/${encodeURIComponent(c.WHATSAPP_PHONE_NUMBER_ID ?? '')}?fields=display_phone_number,verified_name&appsecret_proof=${proof}`;
    const r = await http(deps, url, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 200) {
      const name = str(field(r.json, 'verified_name')) ?? 'your business';
      const phone = str(field(r.json, 'display_phone_number')) ?? '';
      return { service, status: 'ok', detail: `Token, app secret and phone number ID work; sending as "${name}" ${phone}.` };
    }
    const message = providerMessage(r.json);
    const code = field(r.json, 'error', 'code');
    if (/appsecret_proof/i.test(message)) return { service, status: 'fail', detail: 'WHATSAPP_APP_SECRET does not belong to the app that issued the access token.', fix: 'Copy the App secret from the Meta app dashboard (App settings > Basic).' };
    if (code === 190) return { service, status: 'fail', detail: `The access token is invalid or expired: ${message}`, fix: 'Create a permanent System User token in Meta Business Settings (temporary tokens expire after 24 hours).' };
    if (code === 100 || r.status === 404) return { service, status: 'fail', detail: `WHATSAPP_PHONE_NUMBER_ID was not found: ${message}`, fix: 'Copy the Phone number ID (not the phone number) from WhatsApp > API Setup.' };
    return { service, status: 'fail', detail: `HTTP ${r.status}: ${message}` };
  });
  results.push(...(await checkWhatsAppTemplates(c, deps, token, proof)));
  if (isLocal(c.PUBLIC_BASE_URL)) {
    results.push({ service: 'WhatsApp webhook', status: 'warn', detail: 'PUBLIC_BASE_URL is local, so Meta cannot deliver incoming WhatsApp messages.', fix: `After deploying, register ${c.PUBLIC_BASE_URL}/api/webhooks/whatsapp in the Meta app with your WHATSAPP_VERIFY_TOKEN.` });
  }
  return results;
}

/** Booking-message templates must be approved in WhatsApp Manager, in both languages. */
async function checkWhatsAppTemplates(c: AppConfig, deps: CheckDeps, token: string, proof: string): Promise<CheckResult[]> {
  const service = 'WhatsApp templates';
  const names = [c.WHATSAPP_TEMPLATE_HELD, c.WHATSAPP_TEMPLATE_TICKETED, c.WHATSAPP_TEMPLATE_REFUNDED].filter((n): n is string => Boolean(n));
  if (names.length === 0) {
    return [{ service, status: 'warn', detail: 'No templates set: WhatsApp bookers get booking messages (seats held, e-ticket, refund) by SMS and email instead.', fix: 'Create the templates in docs/CONNECT.md (WhatsApp) and set WHATSAPP_TEMPLATE_HELD / _TICKETED / _REFUNDED.' }];
  }
  if (!c.WHATSAPP_BUSINESS_ACCOUNT_ID) {
    return [{ service, status: 'warn', detail: `${names.length} template(s) set (${names.join(', ')}), but they cannot be checked without WHATSAPP_BUSINESS_ACCOUNT_ID.`, fix: 'Set WHATSAPP_BUSINESS_ACCOUNT_ID (WhatsApp Manager > Account tools) to confirm they are approved.' }];
  }
  const waba = c.WHATSAPP_BUSINESS_ACCOUNT_ID;
  return guarded(service, 'graph.facebook.com', async () => {
    const r = await http(deps, `https://graph.facebook.com/${c.WHATSAPP_API_VERSION}/${encodeURIComponent(waba)}/message_templates?fields=name,status,language&limit=200&appsecret_proof=${proof}`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status !== 200) return { service, status: 'fail', detail: `Could not list templates: HTTP ${r.status}: ${providerMessage(r.json)}`, fix: 'Check WHATSAPP_BUSINESS_ACCOUNT_ID and that the token has whatsapp_business_management permission.' };
    const list = (Array.isArray(field(r.json, 'data')) ? (field(r.json, 'data') as unknown[]) : []).map((t) => ({ name: str(field(t, 'name')), status: str(field(t, 'status')), language: str(field(t, 'language')) }));
    const missing: string[] = [];
    for (const name of names) {
      for (const language of [c.WHATSAPP_TEMPLATE_LANG_EN, c.WHATSAPP_TEMPLATE_LANG_AR]) {
        const t = list.find((x) => x.name === name && x.language === language);
        if (t?.status !== 'APPROVED') missing.push(`${name} (${language}): ${t?.status?.toLowerCase() ?? 'not found'}`);
      }
    }
    if (missing.length) return { service, status: 'fail', detail: `Not approved yet: ${missing.join('; ')}.`, fix: 'Submit or fix them in WhatsApp Manager > Message templates; until approved, those booking messages go by SMS instead.' };
    return { service, status: 'ok', detail: `${names.length} template(s) approved in English and Arabic.` };
  });
}

// ------------------------------------------------------------------- staff

function checkStaff(c: AppConfig): CheckResult[] {
  const results: CheckResult[] = [];
  const twoStep = c.STAFF_REQUIRE_2FA ? c.STAFF_REQUIRE_2FA === 'true' : c.NODE_ENV === 'production';
  results.push({
    service: 'Support desk',
    status: 'ok',
    detail: `Staff sign in with their own accounts at ${c.PUBLIC_BASE_URL}/desk.html; two-step login is ${twoStep ? 'required' : 'optional'}. Emergency admin-token sign-in is ${c.ADMIN_API_TOKEN ? 'ON (remove ADMIN_API_TOKEN once an admin account exists, or keep it in a safe place)' : 'off'}.`,
  });
  const ops = (c.OPS_ALERT_EMAILS.length ? c.OPS_ALERT_EMAILS : c.SUPPORT_ALERT_EMAILS).length + (c.OPS_ALERT_PHONES.length ? c.OPS_ALERT_PHONES : c.SUPPORT_ALERT_PHONES).length;
  results.push(
    ops > 0
      ? { service: 'Operations alerts', status: 'ok', detail: `${ops} recipient(s) alerted when a paid booking cannot be ticketed, Duffel funds run low, the AI is down, messages fail, and similar.` }
      : { service: 'Operations alerts', status: c.NODE_ENV === 'production' ? 'fail' : 'warn', detail: 'Nobody is alerted when something critical fails (e.g. a paid booking cannot be ticketed).', fix: 'Set OPS_ALERT_EMAILS and/or OPS_ALERT_PHONES (or the SUPPORT_ALERT_* lists). Also watch /readyz with an uptime monitor.' },
  );
  const alerts = c.SUPPORT_ALERT_EMAILS.length + c.SUPPORT_ALERT_PHONES.length;
  results.push(
    alerts > 0
      ? { service: 'Staff alerts', status: 'ok', detail: `${alerts} recipient(s) alerted about new support requests.` }
      : { service: 'Staff alerts', status: 'warn', detail: 'Nobody is alerted when a traveller asks for a person.', fix: 'Set SUPPORT_ALERT_EMAILS and/or SUPPORT_ALERT_PHONES.' },
  );
  if (!c.AUTH_SECRET) {
    results.push({ service: 'Phone login secret', status: c.NODE_ENV === 'production' ? 'fail' : 'warn', detail: 'AUTH_SECRET is not set: a random one is used per start, so phone logins end at every restart.', fix: 'Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"' });
  }
  return results;
}

/** Runs every check concurrently and returns results in a stable order. */
// ------------------------------------------------------------------- legal

/** Pages whose text still has a "[to be decided/reviewed/completed]" marker for the reviewer. */
export function legalPagesWithOpenMarkers(): string[] {
  return Object.entries(LEGAL_PAGES)
    .filter(([, p]) => /\[to be (decided|reviewed|completed)/i.test(readFileSync(join(LEGAL_DIR, p.file), 'utf8').replace(/<!--[\s\S]*?-->/g, '')))
    .map(([path]) => path);
}

function checkLegal(c: AppConfig): CheckResult[] {
  const service = 'Legal pages (/terms, /privacy, /refunds)';
  if (c.LEGAL_PAGES_APPROVED) {
    const open = legalPagesWithOpenMarkers();
    if (open.length) {
      return [{ service, status: 'fail', detail: `LEGAL_PAGES_APPROVED=true, but ${open.join(', ')} still show [to be …] markers to travellers.`, fix: 'Write the lawyer\'s answers into legal/*.html and remove every marker.' }];
    }
    return [{ service, status: 'ok', detail: `Approved; published for ${c.LEGAL_COMPANY_NAME ?? ''}.` }];
  }
  const missing = (['LEGAL_COMPANY_NAME', 'LEGAL_COMPANY_ADDRESS', 'SUPPORT_EMAIL', 'SUPPORT_PHONE'] as const).filter((k) => !c[k]);
  return [
    {
      service,
      status: 'warn',
      detail: `Shown as drafts${missing.length ? `; not set: ${missing.join(', ')}` : ''}.`,
      fix: 'Have a lawyer review legal/*.html, answer every [to be …] marker, set the company details, then LEGAL_PAGES_APPROVED=true (docs/LAUNCH.md section 1).',
    },
  ];
}

export async function runChecks(c: AppConfig, deps: CheckDeps): Promise<CheckResult[]> {
  const groups = await Promise.all([
    checkClaude(c, deps),
    checkDatabase(c, deps),
    checkDuffel(c, deps),
    checkDpo(c, deps),
    checkStripe(c, deps),
    Promise.resolve(checkBankTransfer(c)),
    Promise.resolve(checkCashOffices(c)),
    checkMomo(c, deps),
    Promise.resolve(checkFx(c, deps)),
    checkResend(c, deps),
    checkTwilio(c, deps),
    checkWhatsApp(c, deps),
    Promise.resolve(checkStaff(c)),
    Promise.resolve(checkLegal(c)),
  ]);
  return groups.flat();
}

/** Webhook addresses to register with each provider that is configured. */
export function webhookUrls(c: AppConfig): { provider: string; url: string }[] {
  const base = c.PUBLIC_BASE_URL;
  return [
    c.STRIPE_SECRET_KEY ? { provider: 'Stripe (events: checkout.session.completed, .async_payment_succeeded, .async_payment_failed, .expired; refund.created, refund.updated, refund.failed)', url: `${base}/api/webhooks/stripe` } : null,
    c.DUFFEL_ACCESS_TOKEN ? { provider: 'Duffel (event: order.airline_initiated_change_detected)', url: `${base}/api/webhooks/duffel` } : null,
    c.WHATSAPP_ACCESS_TOKEN ? { provider: 'WhatsApp (field: messages)', url: `${base}/api/webhooks/whatsapp` } : null,
    c.SMS_CHANNEL_ENABLED ? { provider: 'Twilio incoming SMS (HTTP POST)', url: `${base}/api/webhooks/sms` } : null,
  ].filter((x): x is { provider: string; url: string } => x !== null);
}
