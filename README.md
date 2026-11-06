# BluckFlies ✈️

An AI agent for flight search, booking, payment and travel assistance in South Sudan. See [docs/PRODUCT.md](docs/PRODUCT.md) for what it does and what it will never do.

> **Status:** production data layer in place (PostgreSQL, migrations, encryption at rest, background jobs) and real airline inventory through **Duffel** (tested against a local fake of its API; not yet against Duffel itself). Domestic South Sudan routes and mobile money still run on **sandbox** providers in development: sandbox carriers are fictional ("Sandbox Nile Air" and so on) and fares are generated. Production refuses to start with any sandbox flights.


**Payments in South Sudan:** Visa/Mastercard bank cards (including cards from KCB, Equity, Stanbic and other South Sudanese banks) through DPO Pay; bank transfer or cash deposit at a branch, matched automatically from an imported bank statement or confirmed by staff; and cash at BluckFlies offices or partner agents against a numbered receipt. Stripe and MTN MoMo remain available where configured. See docs/CONNECT.md sections 7a to 7d.

**Connecting the real services** (Claude, database, email, SMS, MTN MoMo, Stripe, Duffel, WhatsApp): follow [docs/CONNECT.md](docs/CONNECT.md), then run `npm run connect:check` to test every key in `.env` with read-only calls.

**Testing from a PC before going live:** [docs/TUNNEL-TEST.md](docs/TUNNEL-TEST.md) puts the web client on Vercel and runs the server on your PC through an ngrok tunnel, with a scripted demo assistant (`AGENT_DEMO=true`, not AI) until the Anthropic key exists.

**Going live:** [docs/DEPLOY.md](docs/DEPLOY.md) (server, HTTPS, encrypted backups and restores), [docs/RUNBOOKS.md](docs/RUNBOOKS.md) (daily desk work, payments, refunds, alerts, incidents) and [docs/LAUNCH.md](docs/LAUNCH.md) (the go-live checklist). Draft Terms, Privacy and Refunds pages are served at `/terms`, `/privacy` and `/refunds` from `legal/*.html`, marked as drafts until a lawyer approves them.
## Quick start

```bash
npm install
cp .env.example .env        # set ANTHROPIC_API_KEY and PAYMENT_WEBHOOK_SECRET
npm run generate            # Prisma client (src/generated, not committed)
npm run dev                 # http://localhost:3000 — in-memory store until DATABASE_URL is set
npm run check               # generate + typecheck + tests + build
npm run eval                # AI quality checks against the real model (needs ANTHROPIC_API_KEY; a few cents)
npm run launch:check -- https://your-domain   # read-only checks of a live site before taking payments
npm run build:web -- --api https://<name>.ngrok-free.app   # static web client + vercel.json (docs/TUNNEL-TEST.md)
```

Try: *"Juba to Nairobi next Friday, 1 adult"*, then *"book the cheapest"*. The agent collects passenger details and shows a **Confirm** card. After you confirm, ask it to pay:
- **By card (Stripe):** the agent returns a Stripe Checkout link. Pay with a [Stripe test card](https://docs.stripe.com/testing) such as `4242 4242 4242 4242`. You're redirected back, and the ticket is issued when Stripe's webhook arrives.
- **By MTN MoMo or Zain m-Gurush (sandbox):** charged in SSP, so first set a current rate (`SSP_PER_USD` + `SSP_RATE_AS_OF` in `.env`, or the admin API below). Then use the demo **Approve payment** button.

### Stripe setup (card payments)

1. Create a Stripe account (test mode is enough to start) and copy a secret key into `STRIPE_SECRET_KEY`.
2. Forward webhooks locally with the [Stripe CLI](https://docs.stripe.com/stripe-cli):
   ```bash
   stripe listen --forward-to localhost:3000/api/webhooks/stripe \
     --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired,refund.created,refund.updated,refund.failed
   ```
   Put the printed `whsec_…` into `STRIPE_WEBHOOK_SECRET`.
3. In production, register `https://<your-domain>/api/webhooks/stripe` in the Dashboard for the same events. Enable the payment methods you want (cards, Apple Pay, Google Pay) under Settings → Payment methods; Checkout shows what's enabled.

> **Account eligibility:** Stripe does not currently list South Sudan as a supported country for merchant accounts. BluckFlies' Stripe account must belong to a legal entity in a supported country (for example a Kenyan or other regional subsidiary, or a company formed elsewhere). Confirm eligibility, payouts and travel-merchant (MCC 4722) requirements with Stripe before launch. Mobile money stays on a local provider either way.

## Flight inventory (Duffel)

Set `FLIGHT_PROVIDER=duffel` and `DUFFEL_ACCESS_TOKEN` (a `duffel_test_…` token outside production) to search and book real airlines through [Duffel](https://duffel.com/docs). Ethiopian Airlines, the main carrier at Juba, is sold by Duffel through the Travelport GDS. The Duffel account must be set to **USD**; offers priced in other currencies are skipped.

**How a booking works with a real airline**

| Airline allows a hold? | At Confirm | When the traveller's payment arrives |
|---|---|---|
| Yes (`booking: "hold"`) | A Duffel **hold** order reserves the seats. The hold expires at the airline's payment deadline if that's earlier than ours. | The order is re-read for the current price and paid from the Duffel balance. If the price **rose**, BluckFlies refunds the traveller instead of paying more. |
| No (`booking: "pay_now"`) | Nothing is booked with the airline yet; the hold lasts only as long as the offer. | An **instant** order is created with balance payment. If the fare sold out or changed, the traveller is refunded in full automatically. |

**Never booking twice.** Duffel has no idempotency keys, but it refuses to book the same offer twice. BluckFlies stores its booking ID in each order's metadata, never automatically retries an order or payment call whose outcome is unclear, and on the next attempt looks the order up first. A lost response is therefore recovered, never re-ordered.

**Cancellations.** A ticketed booking is cancelled with the airline **before** BluckFlies marks it for refund. The traveller is refunded the smaller of the quoted amount and what the airline returns. Some airlines (Ethiopian via Travelport, for now) don't accept API cancellations: the agent then hands the traveller to a person and nothing changes.

**Schedule changes.** Register `https://<domain>/api/webhooks/duffel` in Duffel and set `DUFFEL_WEBHOOK_SECRET`. An `order.airline_initiated_change_detected` event opens a support ticket so a person contacts the traveller.

**Domestic routes** (Juba–Wau, Malakal, Rumbek) were not found on Duffel when this was built; check Duffel's airline list before relying on that. In development `SANDBOX_DOMESTIC_FLIGHTS=true` serves them from the sandbox, clearly labelled. In production that's refused, searches return no flights, and the agent offers a human agent.

**Town airstrips.** BluckFlies also covers Kapoeta, Torit, Yambio, Yei, Bor, Pibor, Pochalla, Maridi, Renk, Bentiu, Kuajok and Aweil (`src/data/airports.ts`). These airstrips have no IATA code, so they use their 4-letter ICAO code (HSKP, HSTR, HSYA, HSYE, HSBR, HSPI, HSPA, HSMD, HSRN, HSBT, HJKJ, HSAW), which cannot collide with an airline code. Lafon and Ruweng (Panrieng) have no airstrip: they resolve to Torit and Bentiu, and the agent says to continue by road. Airline APIs never receive ICAO codes (`RoutedFlightProvider` returns no offers instead) and the search tells the agent to hand the request to a person, since these flights are mostly charter or humanitarian. In development the sandbox flies fictional Juba shuttles to each airstrip. Sources: [Wikipedia, List of airports in South Sudan](https://en.wikipedia.org/wiki/List_of_airports_in_South_Sudan); [OurAirports, South Sudan](https://ourairports.com/countries/SS/airports.html).

**Travellers.** Airlines need each passenger's gender and a contact email, and names in Latin letters exactly as on the passport. Searches take adults, each child's age and lap infants, and a fare can only be booked for the travellers it was priced for.

## Mobile money and SSP charging

Mobile wallets in South Sudan hold **South Sudanese pounds (SSP)**, while fares are priced in USD. Card payments are charged in USD; mobile-money payments are charged in SSP:

- **Locked rate.** When a payment is requested, the current SSP rate (plus `FX_MARKUP_BPS`) is locked onto the payment with its source and date. The charge is rounded **up** to whole pounds. The traveller sees the SSP amount and rate before approving.
- **Exact checks.** A payment is accepted only if the provider reports exactly the locked amount **and** currency.
- **Refunds** return the same share of the SSP charge as the USD refund, rounded **down**; a full refund returns exactly what was paid.

### Exchange rates

The SSP rate moves quickly and has no reliable public feed, so operators enter it (e.g. the Bank of South Sudan daily rate):

```bash
curl -X POST https://<domain>/api/admin/fx-rates \
  -H "Authorization: Bearer $ADMIN_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"currency":"SSP","perUsd":"4612.5","asOf":"2026-11-03T08:00:00Z","source":"Bank of South Sudan official rate"}'
curl https://<domain>/api/admin/fx-rates/SSP -H "Authorization: Bearer $ADMIN_API_TOKEN"   # current + history
```

- Every rate is kept with its source; the newest by `asOf` applies.
- A rate more than 25% away from the current one is rejected unless sent with `"confirmLargeChange": true` (typo guard: `46125` vs `4612.5`).
- When the newest rate is older than `FX_MAX_AGE_HOURS` (default 36), **SSP charges are refused** and the agent offers card instead.
- Restrict `/api/admin` at the reverse proxy (IP allowlist) as well as by token.

### MTN MoMo

Set the `MOMO_*` settings to use MTN's [MoMo Open API](https://momodeveloper.mtn.com) (Collection product; optionally Disbursement for refunds).

> **Availability:** MTN's public list of MoMo API markets does not include South Sudan, and `MOMO_TARGET_ENVIRONMENT` for MTN South Sudan must come from MTN. Confirm API access with MTN South Sudan before relying on this adapter; if MTN offers access only through an aggregator, a new `PaymentProvider` for that aggregator plugs in the same way.

- **No double charges.** MTN treats `X-Reference-Id` as an idempotency key. BluckFlies derives it from its own payment-attempt key, so a timeout, crash or traveller retry re-sends the *same* reference and MTN answers `409` instead of prompting again.
- **Status is always read from MTN.** MTN callbacks are not signed and are not always delivered, so `/api/webhooks/momo` only triggers a status check, and the `payments.poll` job (every 20 seconds) asks MTN about open requests.
- **Refunds** use the Disbursement API (a transfer to the payer's wallet number from MTN's own record) when `MOMO_DISBURSEMENT_*` is set. Without it, a refund opens a support ticket for a person and is marked `manual:` so reconciliation leaves it alone.

**Zain m-Gurush:** no public merchant API was found, so it runs only on the sandbox in development and is unavailable in production. Production never offers a payment method without a real provider; the agent calls `get_payment_options` and offers only what works.

## Designed for travellers who read little

- **Language first:** the first visit asks "English or العربية", with a Listen button on each choice. The choice sets the screen text, the voice language and right-to-left layout for Arabic.
- **Sound on by default:** replies are read aloud. Every card, home tile and step has a Listen button. Sound can be turned off in the top bar.
- **Picture-based home screen:** a large "Tap and speak" button, a "Find a flight" button, and six icon tiles for the six things BluckFlies does.
- **Three-step flight finder:** pick a city tile, then a big day button, then the number of people with +/−. No typing is needed.
- **Plain cards:** big departure and arrival times, a big price, a person icon with the number of travellers, and icon chips ("Direct", "No money back"). Bookings show a coloured status band with an icon ("Ticket ready", "Seats held. Pay now"). Confirmations use large ✓ Yes and ✗ No buttons.
- **On phones:** a bottom menu (Home · Speak · My tickets · Help) with 52px+ touch targets.

## Voice (English and Arabic)

The web client supports voice through the browser's Web Speech API; there is no extra server or API key.

- **Microphone button** in the message box: speak one message; the reply is shown and read aloud.
- **Voice conversation** (the "Voice" button or "Speak instead of typing"): hands-free. It listens, sends, reads the reply, then listens again. It pauses after two silent turns.
- **Listen** on any assistant reply reads it aloud.
- **Language switch** (EN / ع): recognition tries `en-KE` → `en-GB` → `en-US`, or `ar-SD` → `ar-EG` → `ar-SA`, depending on what the browser offers.
- Spoken messages are sent with `channel: "voice"`. The agent then answers in the language spoken, in at most three sentences, with no links or IDs, and confirms unclear place names and numbers.

Limits:

- **Browsers:** recognition works in Chrome, Edge, Safari and Samsung Internet, not Firefox. Voice buttons are hidden where it is unsupported.
- **Network:** it needs an internet connection and runs on the browser vendor's speech service (Google or Apple). BluckFlies receives text only.
- **Read-aloud:** replies are spoken only if the device has a voice for that language. Many Android phones need the Arabic text-to-speech voice installed.
- **Other languages:** Dinka, Nuer, Bari, Zande and other South Sudanese languages are not supported by browser speech services. They would need a server-side speech model (see the roadmap).
- **Microphone access:** the page needs HTTPS (or localhost), and the `Permissions-Policy` header allows the microphone for this origin only.

## Tickets, messages and the support desk

**Messages to travellers.** These are queued in an outbox (the `notifications` table) and delivered by the `notifications.send` job every 15 seconds, with retries and backoff. A provider outage delays a message but never loses it.

| When | Email | SMS |
|---|---|---|
| Seats held | Itinerary and "pay before …" | Short reminder |
| Ticket issued | E-ticket: booking code, ticket numbers, flights, check-in advice | Ticket numbers |
| Refund completed | Confirmation | Confirmation |

- **Language:** messages use the traveller's language (`contact_language`, English or Arabic), set by the agent.
- **No duplicates:** each message has a dedupe key, so it is never queued twice.
- **Backfill:** `notifications.backfill` re-queues ticket and refund messages missed by a crash between the state change and queueing.
- **Development:** without RESEND/TWILIO settings, messages (and login codes) are printed in the server log.

**Works without the AI.** The step-by-step flight finder searches directly (`POST /api/search`), so it is fast, costs no AI tokens and keeps working if the Claude API is down or out of credit; it asks each child's age, because fares are priced for exact ages. Choosing a flight continues with the assistant. If the assistant is unavailable, the traveller sees a "We will call you" form instead of an error: their name, phone and the chosen flight go to the support desk as a `booking_request` (or `callback_request` from Help), with the phone stored encrypted (`POST /api/booking-requests`).

**Finance reports.** Admins download CSV files from **Reports** on the desk (or `GET /api/admin/reports/payments|daily|refunds-owed?from=YYYY-MM-DD&to=YYYY-MM-DD`): the payments ledger (every payment created, paid, changed or refunded in the period, with charged currency, exchange rate and references), a daily summary by Juba day (bookings paid, money received by method by payment date, refunds completed, refunds still owed, requests not yet paid) and the refunds owed now. Payments record when they were paid and refunded, so a later refund never moves the day money was received. Cells are protected against spreadsheet formulas.

**Printable e-ticket (PDF).** Once ticketed, each booking has a "Print e-ticket" button in My tickets, and the e-ticket email includes the same link. The PDF (booking code, airline reference, passengers with ticket numbers, flights in local time, baggage, fare rules, amount paid, check-in advice) is generated without extra dependencies (`src/lib/pdf.ts`, `src/services/ETicketService.ts`). Links are signed with `AUTH_SECRET` and work for 60 days, so they open on any phone or at an internet café; keep `AUTH_SECRET` fixed or older links stop working. Demo bookings are stamped "NOT A VALID TICKET".

**Operations alerts.** Critical failures are sent by email/SMS to `OPS_ALERT_EMAILS` / `OPS_ALERT_PHONES` (default: the support lists), once per booking or at most once an hour, and those that need a person on a booking also open a `system_alert` desk ticket. Covered: paid booking not ticketed, payment amount mismatch, refund failed, airline could not honour a fare, Duffel balance too low or token rejected, AI assistant unavailable (e.g. out of credit), SSP rate out of date, messages or login codes failing, background jobs failing, unexpected server errors. The rules live in `src/services/AlertService.ts`. Alerts go through the database outbox, so also point an external uptime monitor at `GET /readyz` to catch the server or database being down.

**Support desk** (`/desk.html`).
- **Staff accounts:** each person signs in with their own email and password, and a 6-digit code from an authenticator app (two-step login, required in production; `STAFF_REQUIRE_2FA`). Roles: **admin** (everything, including staff and exchange rates), **agent** (tickets, payments, bank statements), **partner** (only cash payments at their office).
- **First admin:** `npm run staff:create-admin` (asks for email, name and password), or the emergency admin-token sign-in on the desk if `ADMIN_API_TOKEN` is set. Admins then add everyone else under **Staff**.
- **Security:** passwords hashed with scrypt; 5 wrong attempts lock an account for 15 minutes; sessions last at most 12 hours and end after 2 idle hours; changing someone's role, disabling them or resetting their password signs them out everywhere; codes cannot be reused; at least one admin always remains.
- **What arrives there:** every "talk to a person" request, change request, airline schedule change and manual refund becomes a ticket.
- **Staff alerts:** staff in `SUPPORT_ALERT_EMAILS` / `SUPPORT_ALERT_PHONES` are alerted for each new ticket.
- **What staff see:** the request, the booking (with the contact phone and email; never passport numbers), the chat transcript and internal notes.
- **What staff can do:** assign, change status, add notes, and text the traveller.
- **Audit trail:** every change records the signed-in person's name (or, for the emergency token, the name typed in, marked "(admin token)").
- **API:** `GET /api/admin/tickets?status=`, `GET/PATCH /api/admin/tickets/:id`, `POST /api/admin/tickets/:id/notes`, `POST /api/admin/tickets/:id/messages`.
- **Booking changes:** a change to a ticketed booking (new date, name fix) goes to the desk as a `change_request` linked to the booking. The agent can only attach the traveller's own booking.

## Traveller accounts (phone login)

On **My tickets**, a traveller enters their phone number and the 6-digit code sent by SMS. Their bookings then appear on any phone they log in from.

- **Code rules:** codes last 10 minutes, are single use and allow 5 attempts. At most 3 codes are sent per number per 15 minutes.
- **Storage:** only an HMAC of the code is stored. Phone numbers are stored encrypted and looked up by keyed hash (`AUTH_SECRET`).
- **Sessions:** a code works only for the browser session that asked for it. Logging out revokes the session token.
- **Web chat token:** kept in the browser's `localStorage` so a chat survives a closed tab or a reloaded phone, and forgotten after 24 hours without use. **New chat** forgets it at once. Trade-off: on a shared phone, the next person could reopen the chat within those 24 hours; that is why the button exists and the window is short.
- **Existing bookings:** bookings made before logging in move to the account at login.
- **Availability:** requires SMS (Twilio) in production.
- **API:** `POST /api/auth/otp/start {phone}`, `POST /api/auth/otp/verify {challengeId, code}`, `GET /api/me`, `POST /api/auth/logout`.

## WhatsApp and SMS

The same agent answers on WhatsApp (Cloud API) and by SMS (Twilio).

- **Signed webhooks:** `X-Hub-Signature-256`; `X-Twilio-Signature`. They are acknowledged immediately and processed in the background, and redeliveries are ignored (message IDs are deduplicated).
- **Sessions:** each sender number gets its own session, linked to the account for that number.
- **Confirming bookings:** the AI still cannot book or cancel by itself. When it proposes, the system sends **✓ Yes / ✗ No** buttons (WhatsApp) or asks for a **YES / NO** reply (SMS). That answer, from the sender's verified number, is applied by the server, not by the model.
- **Card payment:** links are sent as text. MTN MoMo prompts appear on the phone as usual.
- **Voice notes:** not transcribed yet; the traveller is asked to send text (in English and Arabic).
- **Booking messages:** people who booked on WhatsApp get "seats held", "ticket ready" (with the e-ticket link) and "refund done" on WhatsApp, as Meta-approved message templates in their language, instead of SMS. If WhatsApp refuses one, the same message goes by SMS. Template texts and setup: [docs/CONNECT.md](docs/CONNECT.md) section 10a.

Webhooks: `GET/POST /api/webhooks/whatsapp`, `POST /api/webhooks/sms`.

## Database (PostgreSQL)

BluckFlies uses PostgreSQL through **Prisma ORM 7** (`prisma-client` generator, `@prisma/adapter-pg` driver adapter). In Prisma 7 the connection URL lives in `prisma.config.ts`, not in `schema.prisma`, and `.env` is not loaded automatically by the app (the npm scripts pass `--env-file`).

### Running with Docker Compose

```bash
cp .env.example .env
# Fill in: POSTGRES_PASSWORD, BLUCKFLIES_OWNER_PASSWORD, BLUCKFLIES_APP_PASSWORD (hex),
#          DATA_ENCRYPTION_KEYS, PAYMENT_WEBHOOK_SECRET, PUBLIC_BASE_URL (+ ANTHROPIC_API_KEY, Stripe)
docker compose up --build
```

Compose starts `postgres`, runs the one-shot `migrate` service (`prisma migrate deploy` as the schema owner), and starts `app` only after migrations succeed. The app container receives only the variables it needs; it never sees the postgres or owner passwords.

### Running against a local PostgreSQL

```bash
# Once, as a Postgres superuser: creates the database and both roles.
# (psql connection settings come from PGHOST/PGPORT/PGPASSWORD as usual.)
PGHOST=localhost POSTGRES_USER=postgres BLUCKFLIES_OWNER_PASSWORD=… BLUCKFLIES_APP_PASSWORD=… sh deploy/postgres/init-roles.sh

# In .env:
#   MIGRATION_DATABASE_URL=postgresql://bluckflies_owner:…@localhost:5432/bluckflies
#   DATABASE_URL=postgresql://bluckflies_app:…@localhost:5432/bluckflies
#   DATA_ENCRYPTION_KEYS=k1:<base64 32 bytes>
npm run db:deploy           # apply migrations
npm run dev
```

### Database roles

| Role | Used by | Can |
|---|---|---|
| `bluckflies_owner` | `npm run db:deploy` / the `migrate` service only | Own the database and schema; create, alter, drop |
| `bluckflies_app` | The running app (`DATABASE_URL`) | `SELECT/INSERT/UPDATE/DELETE` rows; **cannot** create, alter, drop or truncate tables |

Default privileges grant the app role access to every table future migrations create, so no manual grants are needed after a migration.

### Migrations

- Change `prisma/schema.prisma`, then `npm run db:migrate:dev -- --name <change>` against a development database, review the generated SQL, commit it, and run `npm run generate`.
- Deploy with `npm run db:deploy` (or the Compose `migrate` service) **before** starting the new app version.
- `CHECK` constraints Prisma cannot express are appended by hand to migrations (see `-- Integrity checks` in the initial migration). Prisma Migrate does not diff them, so they survive later migrations. The partial unique index (one open payment per booking) uses Prisma's `partialIndexes` preview feature, so Prisma tracks it.

### What the database enforces

- Unique PNRs, payment provider references, idempotency keys and session token hashes.
- **At most one open payment request per booking** (partial unique index), so two payments can never both be charged.
- PNR format, positive amounts, currency codes, and that a `ticketed` booking has ticket numbers (`CHECK` constraints).
- Every status change is a single `UPDATE … WHERE status IN (…) RETURNING`, so concurrent webhooks, jobs and app instances can't apply the same transition twice.

### Encryption at rest

Passenger details (names, dates of birth, passport numbers), contact details, confirmation payloads and chat transcripts are encrypted per column with AES-256-GCM before reaching the database. Each ciphertext is bound to its table, row and column, so copying it to another row makes it undecryptable.

- **Key rotation:** put the new key first in `DATA_ENCRYPTION_KEYS` and keep the old one after it (`k2:…,k1:…`). New writes use `k2`; existing rows still decrypt with `k1`. Don't remove an old key until a re-encryption pass has rewritten its rows (not built yet).
- **Back up the keyring separately from the database.** Losing every key makes the encrypted columns unreadable.

### Background jobs

Every instance runs the jobs, and a row in `job_leases` ensures only one instance runs each job at a time. All jobs are idempotent.

| Job | Every | Does |
|---|---|---|
| `holds.sweep` | 1 min | Expires unpaid holds, voids their payment links, and releases seats |
| `payments.reconcile` | 5 min | Asks Stripe about payments and refunds left open longer than `RECONCILE_AFTER_MINUTES` (missed webhooks), and retries ticket issuance stuck after a supplier outage |
| `data.cleanup` | 1 h | Deletes expired offers, expires stale confirmations, and removes transcripts, idle sessions and webhook dedupe records older than `DATA_RETENTION_DAYS` |

Set `JOBS_ENABLED=false` to run an instance that only serves traffic.

### Health checks and outages

- `GET /healthz`: liveness. Never touches the database, so an outage doesn't get healthy containers restarted in a loop.
- `GET /readyz`: readiness. Returns 503 while the database is unreachable or unmigrated, so load balancers stop routing to the instance.
- During a database outage, API calls return `503 SERVICE_UNAVAILABLE` with `Retry-After`, and the connection pool recovers on its own.
- On startup, the server exits with an error if the database is unreachable or unmigrated. On `SIGTERM` it stops accepting requests, lets running jobs finish, releases their leases, then closes the pool.

### Backups

Use your provider's automated backups with point-in-time recovery, or schedule `pg_dump --format=custom` as the owner role and test restores regularly. Keep `DATA_ENCRYPTION_KEYS` in a secret manager, separate from the backups.

## Architecture

```
public/            Web client (vanilla ES modules, no build step, CSP-safe, RTL-aware)
  index.html       Home screen, chat / trip-panel split view, voice dialog, language picker
  styles.css       Design tokens (blue #2457E6, violet #805AD5 for AI, white), large-type layout, RTL
  app.js           Home screen, conversation flow, trip panel (flights, route, bookings), views
  js/i18n.js       English and Arabic interface text; switches the page to right-to-left
  js/guide.js      Three-step flight finder with big buttons (where, which day, how many)
  js/hear.js       "Listen" buttons and the Sound on/off setting
  js/voice*.js     Speech recognition and read-aloud; push-to-talk and hands-free voice
  js/              also: api (session), dom helpers, cards, route sketches, airport data
src/
  providers/flights/duffel/  Duffel client, response schemas, provider, webhook handler
  agent/           Claude tool-use loop, tool schemas (Zod → JSON Schema), system prompt
  services/        Business rules: search & ranking, bookings, payments, confirmations, travel info
  providers/       Supplier boundaries: FlightProvider, PaymentProvider (+ sandbox implementations)
  repositories/    Persistence interfaces; in-memory and PostgreSQL (Prisma) implementations
  jobs/            Background job definitions (hold sweeper, reconciliation, cleanup)
  generated/       Prisma client (generated by `npm run generate`, not committed)
  http/            Express app, auth, rate limiting, errors, signed webhook route
  domain/          Types and typed errors
  config/          Zod-validated environment
prisma/            schema.prisma and SQL migrations
deploy/postgres/   Role setup script (least-privilege app role)
tests/             Vitest unit + integration (supertest); repository contract tests
```

### Tests

```bash
npm test                    # everything, in-memory store; no database needed
TEST_DATABASE_URL=postgresql://postgres@localhost:5432/postgres npm run test:pg
```

`test:pg` builds a template database from the real migration SQL, then gives each test file its own copy. It reruns the whole suite on PostgreSQL, plus checks that only make sense there: concurrent transitions, lease races, encryption at rest, and the database constraints.

**Request flow:** the traveller's message goes to `POST /api/chat`, then the agent loop runs. Claude calls a tool, `ToolExecutor` validates the input with Zod and scopes it to the authenticated session, and the service applies its business rules before calling the provider. The result returns to Claude, and the loop repeats until Claude replies.

### Safety controls enforced in code (not just the prompt)

| Risk | Control |
|---|---|
| Agent books or cancels without consent | Agent tools only *propose*. Only `POST /api/confirmations/:id/confirm`, triggered by the traveller's tap, executes. Compare-and-set prevents double execution. |
| Agent handles payment secrets | No tool accepts card or PIN data. Cards are entered only on Stripe Checkout (keeps BluckFlies out of PCI card-data scope); mobile money is approved on the traveller's phone. |
| Phishing links in agent replies | The web client turns only `https://checkout.stripe.com` URLs into links; any other URL stays plain text. |
| Forged or replayed payment webhooks | Stripe: official SDK signature verification (5-minute tolerance); test-mode events are ignored when running with live keys. Mobile money: HMAC-SHA256 over `timestamp.body` with constant-time compare. Both: event-ID dedupe, and an exact amount + currency match required before ticketing. |
| Paying for an expired or cancelled booking | Open Checkout Sessions are expired when a booking is cancelled, expires, or switches method; a payment that still lands is refunded in full automatically. |
| Double charge on retry | Idempotency keys per payment attempt, passed through to the provider. |
| Cross-traveller data access | Session ID comes from the bearer token (stored only as a SHA-256 hash) and never from model input. Lookups return 404 for other sessions' bookings. |
| Hallucinated flights or prices | Offers are bound to the session and server-side IDs. Holds re-validate price and availability with the supplier. |
| Selling fake flights | Production refuses `FLIGHT_PROVIDER=sandbox`, sandbox domestic routes and Duffel test tokens; sandbox results are labelled in every response. |
| Paying the airline more than the traveller paid | Held orders are re-priced before payment; a higher price refunds the traveller instead. Pay-now orders are created for exactly the booked amount. |
| Charging the wrong SSP amount | Rate locked per payment with source and date; stale rates refuse SSP charges; amount and currency must match exactly before ticketing; typo guard on rate entry. |
| Forged mobile-money callbacks | MTN callbacks only trigger a status check against MTN's API; their content is never trusted. |
| Duplicate mobile-money prompts | MTN reference IDs derived from BluckFlies' payment-attempt key, so every retry is idempotent at MTN. |
| Duplicate airline orders | Duffel's one-order-per-offer rule, booking ID in order metadata, lookup-before-issue, and no automatic retries of order or payment calls. |
| Stale holds | Expired on read and by the `holds.sweep` job, with supplier release. Holds never outlive departure minus 2 hours. |
| Late payment after expiry or cancel | Automatic full refund instead of ticketing. |
| Abuse | Rate limits per address, session and messaging sender (sessions, chat, search, login codes, staff sign-in, webhooks), shared by all servers through PostgreSQL (`rate_limits`, hashed keys, expired windows deleted hourly). If the database is briefly unreachable each server keeps limiting on its own. Set `TRUST_PROXY_HOPS` to the number of proxies in front of the app (1 for Caddy/nginx, 2 with a cloud load balancer too) so each visitor's real address is limited. 32 KB body limit. |
| PII in logs | Key-based redaction (passport, phone, email, DOB, tokens). Passports are masked in API responses. |
| PII at rest | AES-256-GCM column encryption for passenger, contact, confirmation and transcript data; retention job deletes old transcripts and idle sessions. |
| Lost webhooks / crashes mid-payment | `payments.reconcile` asks the provider directly; a booking paid but not yet ticketed sits in `ticketing` and is retried, adopting tickets the supplier already issued instead of issuing twice. |

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/sessions` | – | Start an anonymous traveller session → `{ token }` |
| POST | `/api/chat` | Bearer | `{ message }` → `{ reply, stopped, pendingConfirmations, searches }` |
| POST | `/api/chat/stream` | Bearer | Same turn as server-sent events: `step` (tool in use, route for searches), `text` (reply as written), then `done` (the `/api/chat` body) or `error`. Closing the connection stops the turn at the next safe point (a running tool always finishes). |
| GET | `/api/confirmations` | Bearer | Pending proposals |
| POST | `/api/confirmations/:id/confirm` · `/decline` | Bearer | Traveller approves or declines |
| GET | `/api/bookings` · `/api/bookings/:pnr` | Bearer | Traveller's bookings |
| POST | `/api/webhooks/stripe` | `stripe-signature` | Stripe events (registered when Stripe is configured) |
| POST | `/api/webhooks/sandbox` | `bf-signature` HMAC | Sandbox/mobile-money events (sandbox mode only) |
| POST | `/api/sandbox/bookings/:pnr/payment` | Bearer | **Sandbox only:** simulate approval |
| POST | `/api/webhooks/duffel` | `x-duffel-signature` | Airline schedule changes (when Duffel webhooks are configured) |
| PUT/POST | `/api/webhooks/momo` | – (unsigned; triggers a status check only) | MTN MoMo callbacks (when MTN MoMo is configured) |
| POST | `/api/admin/fx-rates` | Bearer `ADMIN_API_TOKEN` | Set an exchange rate (operators) |
| GET | `/api/admin/fx-rates/:currency` | Bearer `ADMIN_API_TOKEN` | Current rate and history |
| GET | `/healthz` | – | Liveness (process up), agent, flight inventory and storage status |
| GET | `/readyz` | – | Readiness (database reachable and migrated) |

## Production roadmap

1. **Flight supply:** Duffel integrated (this phase). Return trips are one search and one booking, priced together by the airline (two Duffel slices). Next: a live check with a Duffel test token, and a partner or agent desk for domestic carriers such as Kush Air.
2. **Payments:** cards live-ready through Stripe; MTN MoMo adapter and SSP charging built (this phase). Next: confirm MTN South Sudan API access (or pick an aggregator), a live check with MTN credentials, and a Zain m-Gurush route if one becomes available.
3. ~~**Persistence**~~ and ~~**background jobs**~~: done (this phase), with operations alerts by email and SMS. Follow-up: a key re-encryption job for key rotation.
4. ~~**Channels and accounts**~~: done (WhatsApp, SMS, phone login, e-ticket messages, support desk). WhatsApp message templates, per-staff desk accounts and combined round-trip fares are done too.
5. **Voice in local languages:** add server-side speech-to-text and text-to-speech for Dinka, Nuer, Bari and other languages, and a phone-call (IVR) channel for travellers without smartphones. Evaluate speech models for these languages, checking accuracy with local speakers and whether the licence allows commercial use.
6. **Operations:** pino logs, metrics on tool error rates and conversion, and a helpdesk integration for `handoff_to_human`. Done: rate limits shared across servers (PostgreSQL, no Redis needed), AI spending limits (daily and per conversation, with alerts and a usage report) and AI quality checks (`npm run eval`, docs/CONNECT.md sections 1a and 1b).
