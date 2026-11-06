# BluckFlies staff runbooks

How the BluckFlies team runs the service day to day: the support desk, money,
airline problems, alerts and incidents. The desk is at `/desk.html`. Server
work (deploying, backups, restores) is in [DEPLOY.md](DEPLOY.md).

Ground rules for everyone:

- **Never ask a traveller for a card number, PIN, password or one-time code**,
  and never type one into the desk. If a traveller sends one, tell them to
  delete it; card details go only on the secure payment page.
- Confirm a payment only when the money is really in the account or in your
  hand, for the **exact** amount. The system ticketing on your word is the point.
- Every desk action is recorded under your name. Use your own account; never
  share it. Two-step login is required.
- When unsure, add a note to the ticket and ask a supervisor rather than guessing.

## 1. Roles

| Role | Can do |
|---|---|
| **Admin** | Everything: staff accounts, finance reports, exchange rates, all tickets. |
| **Agent** | All tickets, confirm bank and cash payments, import bank statements, record refunds paid, message travellers. |
| **Partner** (agent office outside BluckFlies) | Only cash payments taken at their office: confirm or reject, add notes. |

## 2. Daily routine

**Opening (by 08:30 Juba time)**

1. Sign in to the desk. Check **Open** tickets, oldest first. Anything marked
   *system alert* comes first: it is a paid traveller without a ticket, or money
   at risk (section 6).
2. **Import bank statement** (section 3.1) for every account that receives
   transfers, so overnight deposits are ticketed before seats are released.
3. Download **Reports → Refunds owed now**. Every line older than 3 days needs
   action today (section 4).
4. If mobile money in SSP is enabled: post today's SSP rate before the first
   payment (section 5). Without a fresh rate, SSP payments pause automatically.
5. Glance at the Duffel balance (section 7.1).

**During the day**

- Answer *booking request* and *callback request* tickets within
  [to be decided: e.g. 30 minutes] in office hours: call the number on the
  ticket. These come from travellers whose assistant was unavailable or who asked
  for a person.
- Re-import the bank statement around midday and before closing.

**Closing**

- Everything open is either resolved, or has a note saying what happens next and
  who owns it (set yourself as owner with **Mine**).
- Cash offices: count the cash against the day's confirmed cash payments and
  receipts; record any difference as a note on the related tickets and tell the
  finance lead.

## 3. Payments at the bank or office

### 3.1 Bank transfers and deposits

Travellers pay the exact USD amount with their booking code as the reference.

**Fast way: import the statement**

1. Export the account's transactions from online banking as CSV.
2. Desk → **Import bank statement** → choose the file. Nothing changes yet: you
   see each line matched to a booking.
3. Lines marked **Ready to confirm** match the booking code and exact amount.
   Tick them and apply: the tickets are issued.
4. **Amount differs**: do not confirm. Contact the traveller (phone on the
   ticket): they pay the difference, or you agree a refund of what they sent.
5. **Already confirmed**: the line was imported before. Nothing to do.

**By hand (one payment)**

Open the booking's *bank transfer* ticket, check the statement, enter the amount
received and the bank reference, press **Money received**. If the money never
came, press **Not received**: the traveller can pay another way while their
seats are still held.

### 3.2 Cash at an office or partner agent

1. Ask for the booking code; open its *cash office* ticket on the desk.
2. Take **exactly** the amount shown, in US dollars. Check the notes.
3. Write a numbered receipt (two copies; one for the traveller).
4. Enter the amount and the receipt number, press **Cash received**. The ticket is
   issued and sent to the traveller by email and SMS. Hand them the receipt; the
   message has a link to their printable e-ticket.

Never take cash without a booking code, and never confirm before the cash is in
your hand.

### 3.3 Payment after the seats were released

If the hold ended before you confirm, the desk warns you. Confirming still
records the money, and the system starts a full refund instead of ticketing
(seats may be gone). Explain this to the traveller, offer to search again, and
pay the refund (section 4).

## 4. Refunds

Card and mobile-money refunds go back automatically through the payment
provider. Refunds of **bank** and **cash** payments are paid by staff, from a
*payment issue* ticket that says how much to refund and why.

1. Check the amount in the ticket summary (a cancelled refundable fare is the
   amount paid minus the airline penalty; a late payment is refunded in full).
2. Pay it:
   - **Bank**: transfer to the account that paid. Ask the traveller for account
     details by phone and check the name matches the payer. Never pay a third
     party's account without a supervisor's approval in a note.
   - **Cash**: at the same office, against the traveller's original receipt and
     ID; the traveller signs a refund receipt.
3. On the ticket, enter the transfer reference or refund receipt number and press
   **Refund paid**. The booking becomes *refunded*, the traveller gets the
   "refund done" message, and the ticket is resolved.

Check **Reports → Refunds owed now** daily; nothing should wait more than
[to be decided: e.g. 7] days (the refunds policy promises this).

## 5. Exchange rate for SSP (mobile money only)

Mobile-money payments are charged in SSP at the rate staff post. Admins post it
each morning:

```bash
curl -X POST https://bluckflies.com/api/admin/fx-rates \
  -H "Authorization: Bearer <your desk token>" -H "Content-Type: application/json" \
  -d '{"currency":"SSP","perUsd":"4600","asOf":"2026-11-05T07:00:00+02:00","source":"Bank of South Sudan indicative rate"}'
```

Use the agreed source (finance decides which). A change of more than the usual
daily movement is refused unless you add `"confirmLargeChange": true`: check
the number first.

## 6. Alerts: what to do

Alerts go to `OPS_ALERT_EMAILS` and `OPS_ALERT_PHONES`. Those about a booking
also open a *system alert* ticket.

| Alert | What to do |
|---|---|
| **Paid booking not ticketed** | The traveller paid; the airline did not issue. Open the ticket, check the order in the Duffel dashboard (or call the airline for domestic flights). Issue, or refund in full and call the traveller to rebook. Same day. |
| **Payment amount does not match** | No ticket was issued. Call the traveller, then settle the difference or refund (section 4). |
| **Refund failed** | The provider refused a refund. Pay it another way (section 4) and record it. |
| **Card refund failed (Stripe)** | Check the Stripe dashboard; refund another way if needed. |
| **Airline could not honour a paid fare** | Already refunded automatically. Call the traveller to offer another flight. |
| **Cancellation out of step with the airline** | Check the booking and refund with the airline before anything else. |
| **Duffel balance too low** | Top up now (section 7.1). Paid bookings retry by themselves once funds arrive. |
| **Duffel rejected the access token** | Searches and ticketing are failing. Admin: check `DUFFEL_ACCESS_TOKEN`; rotate if needed. |
| **AI assistant unavailable** | Check Anthropic Console billing, the API key and status.anthropic.com. Travellers can still use step-by-step search and "call me": watch for *booking request* tickets. |
| **AI assistant at 80% of its daily budget** | Download **Reports → AI assistant usage**; look for one conversation with unusual use (abuse) or a real rise in traffic. Decide before it reaches 100%. |
| **AI assistant paused: daily budget reached** | The assistant is off until midnight Juba time. If traffic is genuine, an admin raises `AGENT_DAILY_BUDGET_USD` and restarts the app (DEPLOY.md section 6). Staff the phones meanwhile. |
| **SSP exchange rate is out of date** | Post today's rate (section 5). |
| **Messages to travellers are failing** | Check Resend (email) and Twilio (SMS) dashboards and balances. |
| **Login codes by SMS are failing** | Travellers cannot sign in by phone. Check Twilio. |
| **Background job failing / Unexpected server errors** | Technical lead: check `docker compose logs app`. |
| **Uptime monitor: site down** | Section 9.1. |

## 7. Airlines

### 7.1 Duffel balance

Duffel pays airlines from the BluckFlies balance held at Duffel, so tickets can
only be issued while it covers them. Keep at least [to be decided: e.g. two
days'] sales in it. Top up from the balance section of the Duffel dashboard by
bank transfer; transfers take time to arrive, so top up before the alert, not
after.

### 7.2 Schedule changes

When an airline changes a booked flight, a *change request* ticket opens with the
booking. Review the new times in the Duffel dashboard, call the traveller, and
accept or rebook as they choose. Note what was agreed.

### 7.3 Change requests from travellers

The assistant opens a *change request* ticket (new date, name correction,
route). Check the fare rules, quote the airline's fee and fare difference, take
payment for the difference (bank, cash or a card link), make the change with the
airline, and note the new details.

### 7.4 Domestic flights and town airstrips

Online airline inventory does not cover most domestic carriers and airstrips.
Requests arrive as *booking request* or *handoff* tickets. Book with the
carrier by phone or at their office, confirm price and time with the traveller,
and take payment by bank or cash. [To be completed: list of domestic carriers,
contacts and booking procedure.]

## 8. Staff accounts

- **New staff member:** admin → **Staff** → *Add staff member* with their own
  email and role. They sign in and set up two-step login at first sign-in.
- **Lost phone (two-step login):** an admin resets their two-step login from
  **Staff**; they set it up again at next sign-in. Confirm the request by phone first.
- **Someone leaves:** disable their account the same day.
- **Emergency sign-in** (`ADMIN_API_TOKEN`): only when no admin can sign in.
  Every action is recorded as "Name (admin token)". Afterwards, an admin rotates
  the token (section 9.3).

## 9. Incidents

### 9.1 The site is down

1. Check `https://bluckflies.com/readyz` and the uptime monitor.
2. Technical lead, on the server: `docker compose ps`, then
   `docker compose logs --tail 200 app`.
3. Database down or full disk: free space (`df -h`), then
   `docker compose up -d`. App failing to start: the log names the setting or
   migration at fault.
4. While down: answer phones, take booking details by hand, and do not take
   payments that cannot be ticketed.
5. Write a short note afterwards: what happened, how long, what changes.

### 9.2 Data loss or corruption

Restore the latest backup (DEPLOY.md section 5, `restore.sh`). Then reconcile
everything since the backup time against the Duffel, card and bank records.

### 9.3 A secret may have leaked

Rotate it at once, then restart (`docker compose up -d`):

| Secret | How |
|---|---|
| Provider keys (Anthropic, Duffel, Stripe, DPO, Twilio, Resend, Meta) | Create a new key in the provider's dashboard, put it in `.env`, restart, revoke the old one. |
| `ADMIN_API_TOKEN`, `PAYMENT_WEBHOOK_SECRET` | Generate a new value (CONNECT.md section 2). Webhook secrets must change at the provider too. |
| `AUTH_SECRET` | New value: signs everyone out and invalidates e-ticket links (travellers can get new ones from their booking). |
| `DATA_ENCRYPTION_KEYS` | Add a new key **in front**: `k2:<new>,k1:<old>`. Never delete the old key while data uses it. |
| Database passwords | Change the role password in PostgreSQL and in `.env` together. |

### 9.4 Personal data breach

If traveller data may have been exposed: contain it (rotate secrets, close the
hole), record what data and how many people, inform the company's management and
legal adviser the same day, and tell affected travellers what happened and what
to do. [To be completed with the legal adviser: who decides, notification
deadlines, and any authority to inform.]
