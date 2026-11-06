# Connecting BluckFlies to its services

BluckFlies already contains the code for every service below. To connect one,
you create an account with the provider, copy its keys into `.env`, and run the
connection check. Nothing here needs code changes.

```powershell
npm run connect:check
```

The check calls each configured service with a harmless read-only request.
It never books, charges or sends anything, and it never prints your keys.
Every line shows one of:

| Mark | Meaning |
|---|---|
| `[ OK ]` | Connected and working. |
| `[WARN]` | Works, but something is limited; the line says what to do. |
| `[FAIL]` | Not working; the line under it says how to fix it. |
| `[ -- ]` | Not configured; BluckFlies uses its built-in demo instead. |

Restart `npm run dev` after editing `.env`; the server reads it only at start.

**Keep `.env` private.** Never put real keys in `.env.example`, a chat, an
email or Git. If a key leaks, delete it at the provider and create a new one.

## Recommended order

Each step works on its own, so you can stop at any point and still have a working
demo. Test (sandbox) keys first; live keys only when you deploy to production.

1. [Claude](#1-claude-the-ai-agent): the agent itself. Chat does not work without it.
2. [Secrets you generate yourself](#2-secrets-you-generate-yourself): no account needed.
3. [Database](#3-database-postgresql): keeps bookings after a restart.
4. [Resend](#4-resend-email) (email) and [Twilio](#5-twilio-sms) (SMS): e-tickets and phone login.
5. Payments: [DPO Pay](#7a-dpo-pay-bank-cards-from-south-sudanese-banks) for bank cards and
   [bank transfer](#7b-bank-transfer-and-branch-deposits) with [statement matching](#7d-matching-bank-deposits-automatically-statement-import),
   [cash at an office](#7c-cash-at-an-office-or-partner-agent); optionally [Stripe](#7-stripe-cards),
   [MTN MoMo](#6-mtn-momo-mobile-money) and the [SSP rate](#8-ssp-exchange-rate).
6. [Duffel](#9-duffel-real-airline-flights): real airline flights.
7. [WhatsApp](#10-whatsapp-cloud-api): needs a public https address, so usually after deploying.

## 1. Claude (the AI agent)

1. Sign in at <https://console.anthropic.com> and add billing (Settings > Billing).
2. Settings > API keys > Create key. Copy it immediately; it is shown once.
3. In `.env`:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ANTHROPIC_MODEL=claude-sonnet-5-5
   ```
   For lower cost use `claude-haiku-5-5`. Test your common conversations first
   (English, Arabic, voice, return trips, town airstrips): see 1b.
4. In the Anthropic Console, also set a **monthly spend limit** (Settings >
   Limits). It is the last line of defence if everything else fails.

### 1a. Spending limits

BluckFlies meters every AI call (tokens × price) and stops spending at two
limits, counted in Juba days and shared by all servers through the database:

| Setting | Default | What happens |
|---|---|---|
| `AGENT_DAILY_BUDGET_USD` | 20 | Whole service. Ops alert at 80%; at 100% the assistant pauses until midnight Juba time. The website keeps the step-by-step search and "call me"; WhatsApp and SMS travellers are told an agent will call and a call-back ticket opens on the desk. |
| `AGENT_CONVERSATION_BUDGET_USD` | 0.50 | One conversation per day, so one person (or a loop) cannot spend the day's budget. |

To size them, multiply the cost of a typical conversation by the conversations you
expect per day, and add room. The desk's **Reports > AI assistant usage**
download shows calls, conversations, tokens and cost per day.

Prices for `claude-sonnet-5-5` and `claude-haiku-5-5` are built in
(`src/agent/pricing.ts`). If Anthropic changes them, or you use another model,
set `AGENT_PRICE_INPUT_PER_MTOK` and `AGENT_PRICE_OUTPUT_PER_MTOK` (USD per
million tokens) from <https://platform.claude.com/docs/en/about-claude/pricing>.
For an unknown model with no prices set, the highest known prices are used,
so the budget runs out early rather than late, and `npm run connect:check` warns.

### 1b. AI quality checks (evals)

```
npm run eval                       # every scenario once
npm run eval -- --only pin,arabic  # some scenarios
npm run eval -- --repeat 3         # before changing the model or the system prompt
```

This runs scripted conversations through the real assistant and model, on sandbox
flights and a throwaway in-memory store (no real bookings, payments or messages),
and checks the behaviour that matters: asks who is travelling before searching,
never reserves without passport details, never repeats card numbers or PINs,
ignores prompt injection, answers Arabic in Arabic, explains towns without an
airstrip, hands over to a person when asked, and uses plain text on WhatsApp.

It prints PASS/FAIL per scenario with the cost, saves a report in
`evals/results/`, and exits with an error if any scenario fails. A run of
every scenario costs a few cents (`--max-usd` caps it, default $2). Model
answers vary between runs, so use `--repeat 3` before switching models.
When a real conversation goes wrong, add it to `src/evals/scenarios.ts` so the
fix stays fixed.

## 2. Secrets you generate yourself

Run each command in PowerShell and paste the output into `.env`:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Use a **separate** output for each of `PAYMENT_WEBHOOK_SECRET` and `AUTH_SECRET`.

Support desk accounts: once the database is set up (section 3), create the first
admin with `npm run staff:create-admin`, sign in at `/desk.html`, set up two-step
login, and add your staff under **Staff**. `ADMIN_API_TOKEN` (same command) is an
optional emergency sign-in; keep it in a safe place or leave it blank.

```powershell
node -e "console.log('k1:'+require('crypto').randomBytes(32).toString('base64'))"
```
Paste into `DATA_ENCRYPTION_KEYS`. It encrypts passport numbers, phones and
chats in the database. **Back it up somewhere safe**: if you lose it, that data
can never be read again. Changing `AUTH_SECRET` signs everyone out.

Set who is alerted when something critical fails (a paid booking that cannot be
ticketed, Duffel balance too low, the AI assistant down, messages failing):
```
OPS_ALERT_EMAILS=ops@yourdomain.com
OPS_ALERT_PHONES=+2119xxxxxxxx
```
and add a free uptime monitor (for example UptimeRobot or Better Stack) that checks
`https://<your-domain>/readyz` every minute, for when the server itself is down.

Set who is alerted when a traveller asks for a person:
```
SUPPORT_ALERT_EMAILS=you@example.com
SUPPORT_ALERT_PHONES=+2119xxxxxxxx
```

## 3. Database (PostgreSQL)

Easiest on Windows: Docker Desktop, using the included `docker-compose.yml`.

1. Generate three passwords (hex, so they are safe in URLs) with the first command
   in section 2, and set `POSTGRES_PASSWORD`, `BLUCKFLIES_OWNER_PASSWORD` and
   `BLUCKFLIES_APP_PASSWORD`.
2. Start only the database and create the tables:
   ```powershell
   docker compose up -d postgres
   docker compose run --rm migrate
   ```
3. Point `npm run dev` at it (replace the passwords):
   ```
   DATABASE_URL=postgresql://bluckflies_app:<APP_PASSWORD>@localhost:5432/bluckflies
   MIGRATION_DATABASE_URL=postgresql://bluckflies_owner:<OWNER_PASSWORD>@localhost:5432/bluckflies
   ```
   The app role can only read and write rows; only the owner role changes tables.

After each update that adds a migration, run `npm run db:deploy` (the check tells you).

## 4. Resend (email)

1. Sign up at <https://resend.com>.
2. Domains > Add domain (e.g. `bluckflies.com`). Add the DNS records it shows at
   your domain registrar, then press Verify. Wait until it says **Verified**.
3. API Keys > Create. "Sending access" is enough (the check then says WARN that it
   cannot see your domains; that is expected).
4. In `.env`:
   ```
   RESEND_API_KEY=re_...
   EMAIL_FROM=BluckFlies <tickets@bluckflies.com>
   ```

## 5. Twilio (SMS)

1. Sign up at <https://www.twilio.com>. Trial accounts only text numbers you
   verify in Twilio; upgrade before real travellers use phone login.
2. Copy the **Account SID** and **Auth token** from the Console home page.
3. Get a sender: Phone Numbers > Buy a number, or a Messaging Service (its SID
   starts with `MG`). Check Twilio's SMS guidelines for South Sudan (+211):
   which sender types are allowed and delivered there depends on the networks.
4. In `.env`:
   ```
   TWILIO_ACCOUNT_SID=AC...
   TWILIO_AUTH_TOKEN=...
   TWILIO_FROM=+1...        (or MG...)
   ```
5. Optional: let travellers chat by SMS. Set `SMS_CHANNEL_ENABLED=true` and, once
   deployed, set the number's "A message comes in" webhook to
   `https://<your-domain>/api/webhooks/sms` (HTTP POST).

## 6. MTN MoMo (mobile money)

**Sandbox (for testing):**

1. Sign up at <https://momodeveloper.mtn.com>, subscribe to the **Collections**
   product, and copy its Primary key.
2. Create a sandbox API user and key (PowerShell):
   ```powershell
   $sub = "<Collections primary key>"
   $id  = [guid]::NewGuid().ToString()
   Invoke-RestMethod -Method Post -Uri "https://sandbox.momodeveloper.mtn.com/v1_0/apiuser" `
     -Headers @{ "X-Reference-Id" = $id; "Ocp-Apim-Subscription-Key" = $sub } `
     -ContentType "application/json" -Body '{"providerCallbackHost":"localhost"}'
   $key = (Invoke-RestMethod -Method Post -Uri "https://sandbox.momodeveloper.mtn.com/v1_0/apiuser/$id/apikey" `
     -Headers @{ "Ocp-Apim-Subscription-Key" = $sub }).apiKey
   "MOMO_COLLECTION_API_USER=$id"; "MOMO_COLLECTION_API_KEY=$key"
   ```
3. In `.env` (the sandbox only uses EUR):
   ```
   MOMO_BASE_URL=https://sandbox.momodeveloper.mtn.com
   MOMO_TARGET_ENVIRONMENT=sandbox
   MOMO_CURRENCY=EUR
   MOMO_COLLECTION_SUBSCRIPTION_KEY=<Collections primary key>
   MOMO_COLLECTION_API_USER=<printed above>
   MOMO_COLLECTION_API_KEY=<printed above>
   ```
4. Optional, for automatic refunds: subscribe to **Disbursements** and repeat
   step 2 with its key for the `MOMO_DISBURSEMENT_*` values. Without it, MoMo
   refunds become tickets on the support desk.

**Live:** contact MTN South Sudan's business team to go live. They issue
production credentials and the exact `MOMO_TARGET_ENVIRONMENT` value (MTN's public
list does not include South Sudan). Then set `MOMO_BASE_URL=https://proxy.momoapi.mtn.com`
and `MOMO_CURRENCY=SSP`.

## 7. Stripe (cards)

Stripe only opens accounts for businesses registered in supported countries;
check <https://stripe.com/global> for where your company is registered.

1. In the Stripe Dashboard, switch to **Test mode**.
2. Developers > API keys > Create restricted key with **Write** access to
   Checkout Sessions and Refunds (nothing else). Copy the `rk_test_...` key.
3. Webhook secret:
   - On your PC: install the Stripe CLI and run
     `stripe listen --forward-to localhost:3000/api/webhooks/stripe`; it prints a `whsec_...`.
   - In production: Developers > Webhooks > Add endpoint
     `https://<your-domain>/api/webhooks/stripe` with the events
     `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
     `checkout.session.async_payment_failed`, `checkout.session.expired`,
     `refund.created`, `refund.updated`, `refund.failed`; copy its signing secret.
4. In `.env`:
   ```
   STRIPE_SECRET_KEY=rk_test_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   ```
Live keys (`_live_`) are refused unless `NODE_ENV=production`, so real cards
cannot be charged by accident.

## 7a. DPO Pay (bank cards from South Sudanese banks)

South Sudanese banks such as KCB, Equity Bank and Stanbic issue Visa debit cards
(Equity also offers USD and SSP cards). DPO Pay (Network International) takes Visa
and Mastercard on a hosted page with 3-D Secure, so BluckFlies never sees card numbers.

1. Apply for a DPO Pay merchant account at <https://dpogroup.com>. DPO onboards
   businesses in the countries it serves; if your company is registered only in
   South Sudan, ask DPO whether they can onboard it or whether you need an entity
   in a country they cover (e.g. Kenya or Uganda).
2. DPO gives you a **company token** and a numeric **service type** (create one
   for flights). In `.env`:
   ```
   DPO_COMPANY_TOKEN=XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX
   DPO_SERVICE_TYPE=<number>
   ```
   If Stripe is also configured, add `CARD_PROVIDER=dpo`.
3. Make one small real payment with your own card and check it appears in the
   DPO portal; `connect:check` can verify the token but not the service type.
4. Refunds: by default staff refund card payments in the DPO portal from a desk
   ticket. Set `DPO_AUTO_REFUNDS=true` to refund through DPO's API instead.

How it is kept safe: DPO's return and notification are not signed, so BluckFlies
treats them only as a signal and always asks DPO for the real status
(`verifyToken`). It also checks open card payments every 20 seconds, so a
traveller who closes the browser after paying is still ticketed. A different
amount or currency is never ticketed.

Tell travellers: the card must be enabled for **online payments** by their bank;
USD cards work best. If a card is declined, they can ask their bank, try another
card, or pay by bank transfer.

## 7b. Bank transfer and branch deposits

For travellers without an online-enabled card. They pay in USD into your account,
by transfer or cash at a branch, with the booking code as the reference.

1. In `.env` (your real USD account):
   ```
   BANK_NAME=KCB Bank South Sudan
   BANK_ACCOUNT_NAME=BluckFlies Ltd
   BANK_ACCOUNT_NUMBER=...
   BANK_BRANCH=Juba Main
   BANK_SWIFT=...            (optional, for international transfers)
   ```
2. Set `ADMIN_API_TOKEN` and `SUPPORT_ALERT_*` (section 2): every bank-transfer
   request opens a ticket on `/desk.html` and alerts staff.
3. When the money shows on the bank statement, open the ticket and press
   **Money received**, entering the exact amount and the bank's reference.
   BluckFlies then issues the tickets and sends the e-ticket. Press **Not received**
   if nothing arrived, so the traveller can pay another way.
   - A different amount is refused: contact the traveller instead.
   - Money that arrives after the seats were released is recorded and a refund
     ticket is opened, instead of issuing a ticket.
4. Seat holds last `HOLD_TTL_MINUTES` (60 by default). For bank payments a longer
   hold helps (e.g. `HOLD_TTL_MINUTES=240`), but airlines may release seats
   sooner; the traveller always sees the deadline.

## 7c. Cash at an office or partner agent

For travellers who prefer to pay cash in person.

1. List each place that takes cash for you, separated by `;`, as
   `name | address | opening hours`:
   ```
   CASH_OFFICES=BluckFlies Juba | Hai Malakal, Juba | Mon-Sat 08:00-17:00; Nile Travel (partner) | Konyo Konyo, Juba | Daily 09:00-18:00
   ```
2. The traveller is shown these places, the amount and their booking code. Each
   request opens a desk ticket.
3. When they pay, issue a **numbered receipt**, open the ticket on `/desk.html`,
   and press **Cash received** with the exact amount and the receipt number.
   Partner agents need their own desk sign-in (their name is recorded on every
   confirmation) or should phone your office to confirm.

## 7d. Matching bank deposits automatically (statement import)

Instead of checking deposits one by one:

1. Export the account statement from your bank's internet banking as **CSV**
   (with a header row), for example for today.
2. On `/desk.html` press **Import bank statement** and choose the file.
3. BluckFlies lists every deposit whose description contains an open booking code:
   - **Ready to confirm**: booking code and exact amount. Ticked by default.
   - **Amount differs** or **second payment for this booking**: not confirmed; contact the traveller.
   - Other income (no booking code) is counted and ignored.
4. Press **Confirm N payments**. Tickets are issued, and each booking's desk ticket
   gets a note with your name and the bank reference. Importing the same statement
   again cannot confirm anything twice.

Columns are recognised by name: an incoming amount (`Credit`, `Deposit` or
`Amount`), optionally `Currency`, `Reference` and `Date`; all other text is searched
for booking codes. If your bank's export is not recognised, the import says which
column it could not find.

Bank and cash are only offered while at least `MANUAL_PAYMENT_MIN_MINUTES` (45 by
default) remain on the seat hold, so travellers are not sent to a bank they cannot
reach in time; the agent offers card instead.

## 8. SSP exchange rate

Mobile money is charged in SSP at a locked rate, and BluckFlies has no default
rate on purpose. Staff post the current rate (with its real source and time)
using the `ADMIN_API_TOKEN`:

```powershell
$h = @{ Authorization = "Bearer <ADMIN_API_TOKEN>" }
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/admin/fx-rates" -Headers $h `
  -ContentType "application/json" `
  -Body '{"currency":"SSP","perUsd":"<rate>","asOf":"2026-11-04T08:00:00Z","source":"<where the rate came from>"}'
```
Payments in SSP are refused when the newest rate is older than `FX_MAX_AGE_HOURS`
(36 by default), so post a fresh rate every day.

## 9. Duffel (real airline flights)

1. Sign up at <https://app.duffel.com>. Developers > Access tokens > create a
   **test** token (`duffel_test_...`). Test mode makes test bookings, no real tickets.
2. In `.env`:
   ```
   FLIGHT_PROVIDER=duffel
   DUFFEL_ACCESS_TOKEN=duffel_test_...
   SANDBOX_DOMESTIC_FLIGHTS=true
   ```
   Keep `SANDBOX_DOMESTIC_FLIGHTS=true` for demos: domestic South Sudan routes and
   town airstrips are not sold through airline APIs, so in production those
   requests go to your support desk.
3. Once deployed, add a webhook in Duffel to `https://<your-domain>/api/webhooks/duffel`
   (event `order.airline_initiated_change_detected`) and copy its secret to
   `DUFFEL_WEBHOOK_SECRET`, so travellers hear about schedule changes.
4. Live tokens need Duffel to approve your account first; they are refused unless
   `NODE_ENV=production`.

## 10. WhatsApp (Cloud API)

Needs a public https address, because Meta delivers messages to your server.

1. At <https://developers.facebook.com> create an app (type **Business**) and add
   the **WhatsApp** product.
2. WhatsApp > API Setup: copy the **Phone number ID** (not the phone number) into
   `WHATSAPP_PHONE_NUMBER_ID`. Add your real business number when ready.
3. Token: the one on the API Setup page expires in 24 hours. For a permanent one,
   in Meta Business Settings create a **System user**, give it the app with
   `whatsapp_business_messaging` permission, and generate a token for
   `WHATSAPP_ACCESS_TOKEN`.
4. App settings > Basic > **App secret** into `WHATSAPP_APP_SECRET`.
5. Make up a random `WHATSAPP_VERIFY_TOKEN` (first command in section 2).
6. WhatsApp > Configuration > Webhook: callback URL
   `https://<your-domain>/api/webhooks/whatsapp`, verify token = your
   `WHATSAPP_VERIFY_TOKEN`, then subscribe to the **messages** field.

### 10a. Booking messages on WhatsApp (message templates)

People who book on WhatsApp get their booking messages on WhatsApp instead
of SMS. Meta only lets a business start a conversation (for example "your
ticket is ready" an hour after the last chat) with a **message template**
that Meta has approved. Until the templates are approved and set in `.env`,
those people get SMS, as everyone else does.

1. WhatsApp Manager > **Message templates** > Create template. Category
   **Utility**. Create each template below in **English** and **Arabic** with
   the same name. Use these texts so the numbered values match.
2. Copy the **WhatsApp Business Account ID** (WhatsApp > API Setup) into
   `WHATSAPP_BUSINESS_ACCOUNT_ID`, so `npm run connect:check` can confirm the
   templates are approved.
3. Put the template names in `WHATSAPP_TEMPLATE_HELD`,
   `WHATSAPP_TEMPLATE_TICKETED` and `WHATSAPP_TEMPLATE_REFUNDED`. If you chose
   language codes other than `en` and `ar` (for example `en_US`), set
   `WHATSAPP_TEMPLATE_LANG_EN` / `WHATSAPP_TEMPLATE_LANG_AR`.

**`bluckflies_seats_held`**: {{1}} booking code, {{2}} route, {{3}} total, {{4}} pay-by time

> English: BluckFlies: your seats are held. Booking code {{1}}, {{2}}. Please pay {{3}} before {{4}} (Juba time) or the seats are released. Reply here to pay. We will never ask for your PIN.
>
> Arabic: بلك فلايز: تم حجز مقاعدك. رمز الحجز {{1}}، {{2}}. يرجى دفع {{3}} قبل {{4}} (بتوقيت جوبا) وإلا سيتم إلغاء الحجز. رد هنا للدفع. لن نطلب منك رقمك السري أبداً.

**`bluckflies_ticket_issued`**: {{1}} booking code, {{2}} route and departure, {{3}} ticket numbers, {{4}} e-ticket link

> English: BluckFlies: payment received, your ticket is ready. Booking code {{1}}, {{2}}. Ticket numbers: {{3}}. Print or show your e-ticket: {{4}}. Bring the passport or ID used for the booking.
>
> Arabic: بلك فلايز: تم استلام الدفع وتذكرتك جاهزة. رمز الحجز {{1}}، {{2}}. أرقام التذاكر: {{3}}. اطبع تذكرتك أو أظهرها: {{4}}. أحضر جواز السفر أو الهوية المستخدمة في الحجز.

**`bluckflies_refund_done`**: {{1}} booking code

> English: BluckFlies: the refund for booking {{1}} has been sent back to the way you paid. It can take a few days to show, depending on your bank.
>
> Arabic: بلك فلايز: تمت إعادة المبلغ الخاص بالحجز {{1}} إلى وسيلة الدفع الأصلية. قد يستغرق ظهوره بضعة أيام حسب البنك.

Meta asks for an example value for each `{{n}}` when you submit, for example
`BRR234`, `Juba → Nairobi`, `$412.50`, `Fri 6 Nov 14:00`.

If WhatsApp refuses a message (template not approved, number not on
WhatsApp), BluckFlies sends the same message by SMS instead, so nobody misses
their ticket.

## Webhooks and a public address

Stripe, Duffel, MTN, Twilio and Meta send events to your server, which they cannot
do while it only runs on `localhost`. Payments still complete locally, because
BluckFlies also asks the providers directly: MTN MoMo every 20 seconds, Stripe
after about 15 minutes (`RECONCILE_AFTER_MINUTES`). Incoming WhatsApp and SMS
chats and airline schedule changes do need the public address. When you deploy,
set `PUBLIC_BASE_URL=https://<your-domain>`; `npm run connect:check` then prints
the exact webhook address to register for each service you configured.

`npm run connect:check` exits with an error code when any check fails, so you can
run it before each deployment.
