# BluckFlies launch checklist

Work through this top to bottom. Each item says who usually owns it. Nothing
here is optional for a launch that takes real money, unless marked *(if used)*.
Server steps are in [DEPLOY.md](DEPLOY.md), provider setup in
[CONNECT.md](CONNECT.md), daily operations in [RUNBOOKS.md](RUNBOOKS.md).

## 1. Business and legal (founder, lawyer)

- [ ] Company registered; trading licence for a travel agency obtained from the
      competent South Sudan authorities. [To be confirmed with the lawyer: which
      licences a travel agent selling air tickets needs, e.g. tourism/civil
      aviation authorisations, and any IATA or airline agency agreements.]
- [ ] Business bank account(s) in USD for transfers and deposits, and the
      account details in `BANK_*`.
- [ ] Card acquiring approved for a travel merchant: DPO Pay and/or Stripe (CONNECT.md 7, 7a).
- [ ] Duffel live account approved and funded (CONNECT.md 9; RUNBOOKS.md 7.1).
- [ ] Domestic carriers: agreements, contacts and booking procedure written into RUNBOOKS.md 7.4.
- [ ] Legal pages reviewed by a lawyer: `legal/terms.html`, `legal/privacy.html`,
      `legal/refunds.html`. Every `[to be decided]` / `[to be reviewed]` /
      `[to be completed]` marker answered. Points for the reviewer:
  - South Sudan has no general data protection law yet (a bill was announced
    for 2026); the privacy notice follows international practice. Check the
    Cybercrime and Computer Misuse Act 2026 and any sector rules.
  - Travellers abroad (diaspora, visitors) may have rights under their own
    country's law: decide how far to cover this.
  - Liability limits, governing law and dispute forum (terms 12, 14).
  - Data processing agreements with each provider listed in the privacy notice.
- [ ] Arabic translations of the three legal pages (most travellers read Arabic). [Not built yet.]
- [ ] `LEGAL_COMPANY_NAME`, `LEGAL_COMPANY_ADDRESS`, `LEGAL_COMPANY_REGISTRATION`,
      `SUPPORT_EMAIL`, `SUPPORT_PHONE` set; then `LEGAL_PAGES_APPROVED=true`
      (removes the "draft" banner).
- [ ] Business decisions written into the policies: service fee (if any),
      complaint and refund response times, refund payout deadline for bank and cash.

## 2. Server and data (technical lead)

- [ ] Server prepared and hardened (DEPLOY.md 2, 8).
- [ ] `.env` complete for production; `npm run connect:check` equivalent
      (`docker compose run --rm app node dist/cli/checkConnections.js`) shows
      no **fail** and only warnings you accept.
- [ ] HTTPS works at the real domain; `/readyz` returns 200.
- [ ] `npm run launch:check -- https://<your domain>` (from any computer) shows 0 failed:
      HTTPS and certificate, security headers, legal pages, admin API and
      webhooks refuse forged requests, sandbox switched off, real flights,
      payment methods. Run it again after every deployment.
- [ ] `TRUST_PROXY_HOPS` matches the proxies in front (1 for Caddy alone).
- [ ] Every webhook URL printed by the check is registered with its provider.
- [ ] Secrets (`.env`, especially `DATA_ENCRYPTION_KEYS`) and the backup private
      key stored in the password manager, accessible to two people.
- [ ] Nightly backup running and copying off-site; **one restore drill passed**
      (DEPLOY.md 5) and recorded.
- [ ] External uptime monitor on `/readyz`, alerting two people.
- [ ] Anthropic Console: monthly spend limit set; `AGENT_DAILY_BUDGET_USD` and
      `AGENT_CONVERSATION_BUDGET_USD` sized (CONNECT.md 1a).

## 3. Product checks with real money (whole team, a day before launch)

Use small real amounts and a real route; refund each test afterwards. The team
records each run (who, booking code, amount, result, refund) in the shared
**BluckFlies launch money tests** doc: 15 tests, of which only 3 issue a real
ticket (4 with mobile money), all on refundable fares.

- [ ] Search and book Juba → Nairobi one way, pay by **card**: ticket issued,
      email + SMS received, e-ticket PDF opens and prints, names correct.
- [ ] Book a **return trip**: one booking code, both directions on the e-ticket.
- [ ] Pay by **bank transfer**: import the statement, confirm, ticket issued.
- [ ] Pay **cash at an office**, as the partner role: confirm, ticket issued.
- [ ] **Cancel** a refundable booking: refund amount as promised; card refund
      arrives; a cash refund is paid and recorded with **Refund paid**.
- [ ] Late payment after the hold ends: refunded, not ticketed.
- [ ] WhatsApp: book through WhatsApp; booking messages arrive as templates
      (CONNECT.md 10a) *(if used)*.
- [ ] SMS conversation and phone sign-in *(if used)*.
- [ ] Mobile money in SSP with today's rate *(if used)*.
- [ ] Voice in English and Arabic on an Android phone and an iPhone.
- [ ] Step-by-step search works with the AI key removed (assistant down), and
      "call me" creates a desk ticket.
- [ ] Town airstrip request (e.g. Juba → Bor) reaches the desk.
- [ ] `npm run eval -- --repeat 3` passes on the production model (CONNECT.md 1b).
- [ ] Footer links to Terms, Privacy and Refunds work on mobile, in both languages.

## 4. People (operations lead)

- [ ] Every staff member has a personal desk account with two-step login; the
      emergency `ADMIN_API_TOKEN` is blank or stored safely.
- [ ] Staff trained on RUNBOOKS.md sections 2–4 and have practised on test bookings.
- [ ] Partner offices trained on cash (RUNBOOKS.md 3.2) with receipt books.
- [ ] `OPS_ALERT_EMAILS` / `OPS_ALERT_PHONES` reach people who will act,
      including outside office hours; a rota exists.
- [ ] Support phone number answered during published hours.

## 5. Launch day

- [ ] Fresh backup taken before opening.
- [ ] Duffel balance topped up for the expected first days.
- [ ] SSP rate posted *(if mobile money)*.
- [ ] One person watching the desk, alerts and `docker compose logs -f app`.
- [ ] Announce.

## 6. First week

- [ ] Daily: Refunds owed report, AI usage report, open tickets, alerts reviewed.
- [ ] Read a sample of AI conversations (desk transcripts) for mistakes; add
      any problem to `src/evals/scenarios.ts` so it stays fixed.
- [ ] Check backup files arrive off-site every night.
- [ ] Review: what went wrong, what to change in the runbooks.
