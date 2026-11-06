# Test BluckFlies from your PC: ngrok + Vercel

A temporary setup for showing and testing BluckFlies on real phones before
the production server and the Anthropic key exist.

```
phone ──https──▶ Vercel (web pages, icons, fonts)
                    │  /api/…, /e/…, /terms, /privacy, /refunds
                    │  + x-origin-secret header
                    ▼
                 ngrok (free tunnel) ──▶ your PC: npm run dev (port 3000)
```

- **Vercel** serves the web client and forwards everything dynamic to your PC.
  The browser only ever talks to Vercel, so there is no CORS and the same
  security headers as the server apply.
- **ngrok** gives your PC a fixed public address. Your PC refuses any request
  that does not carry the secret Vercel adds (`ORIGIN_SECRET`), so the ngrok
  address alone is useless to anyone who finds it.
- **The demo assistant** (`AGENT_DEMO=true`) stands in for the AI until you
  have an Anthropic key. It is **not AI**: it understands "Juba to Nairobi on
  20 November" and "talk to a person", runs the real flight search and desk
  hand-off, and says "(Demo assistant, not AI.)" in every reply. Booking in the
  chat needs the real assistant. Add `ANTHROPIC_API_KEY` later and the real one
  takes over with no other change.

**What works:** home page, step-by-step search and flight cards, chat with live
steps and streaming text, Stop, "talk to a person", My tickets, the staff desk
(`/desk.html`), legal pages, Arabic, voice.
**Limits:** data is in memory (lost when `npm run dev` restarts); flights are
sandbox demo data; the site stops working when your PC, `npm run dev` or ngrok
stops. ngrok's free plan allows 20,000 requests and 1 GB a month.

Run every command in the VS Code terminal (PowerShell), in
`C:\Users\josep\Projects\bluckflies` unless it says otherwise.

## 1. ngrok (once)

1. Create a free account at https://dashboard.ngrok.com/signup.
2. Install: `winget install ngrok.ngrok` (or download from https://ngrok.com/download), then open a new terminal.
3. Connect it to your account (the token is on the dashboard under **Your Authtoken**; it is a secret, do not share it):
   ```powershell
   ngrok config add-authtoken <your-authtoken>
   ```
4. Note your free address: dashboard → **Domains**, e.g. `https://example-name.ngrok-free.app`.
   It stays the same every time, so Vercel only needs it once.

## 2. Settings on your PC (once)

Make a random secret and add the test settings to `.env` (never to `.env.example`):

```powershell
$secret = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
Add-Content .env "`nAGENT_DEMO=true`nORIGIN_SECRET=$secret`nTRUST_PROXY_HOPS=2"
Set-Clipboard $secret   # you paste it into Vercel in step 4
```

- `TRUST_PROXY_HOPS=2`: requests pass through Vercel and ngrok, so the
  server reads the traveller's real address two hops back (rate limits).
- If `.env` already has a `TRUST_PROXY_HOPS` or `AGENT_DEMO` line from earlier, delete the old line so each setting appears once.

## 3. Start the server and the tunnel (each test session)

Terminal 1:

```powershell
npm run dev
```

The start line must say `"agent":"demo"`.

Terminal 2 (VS Code: **+** in the terminal panel):

```powershell
ngrok http 3000
```

Check from a third terminal (replace the address):

```powershell
curl.exe https://example-name.ngrok-free.app/healthz                 # {"status":"ok","agent":"demo",...}
curl.exe -X POST https://example-name.ngrok-free.app/api/sessions    # Forbidden: good, only Vercel gets in
```

## 4. Vercel (first time)

1. Create a free account at https://vercel.com/signup.
2. Build the static site, pointing it at your ngrok address:
   ```powershell
   npm run build:web -- --api https://example-name.ngrok-free.app
   ```
3. Link it to a new Vercel project, add the secret, and deploy:
   ```powershell
   cd web-dist
   npx vercel login
   npx vercel link                              # "Set up?" Yes → your account → new project, e.g. bluckflies-test
   npx vercel env add ORIGIN_SECRET production  # paste the secret (Ctrl+V); answer Yes to "sensitive" if asked
   npx vercel deploy --prod
   cd ..
   ```
   If Vercel asks about build settings, keep the defaults (no framework, no
   build command). The project link is saved in `web-dist/.vercel/` and kept by
   later builds.
4. Open the address it prints (e.g. `https://bluckflies-test.vercel.app`) on
   your phone. Type "Juba to Nairobi on 20 November".

**Optional, for link previews and e-ticket links:** put the Vercel address in
`.env` as `PUBLIC_BASE_URL=https://bluckflies-test.vercel.app`, restart
`npm run dev`, and rebuild with it:

```powershell
npm run build:web -- --api https://example-name.ngrok-free.app --site https://bluckflies-test.vercel.app
cd web-dist; npx vercel deploy --prod; cd ..
```

## 5. After changing the web client

Rebuild and deploy again (step 4.2 and `npx vercel deploy --prod` in
`web-dist`). Server changes only need `npm run dev` (it reloads by itself).

## 6. Stop

`Ctrl+C` in both terminals. The Vercel site then shows "not available" errors
for the chat; the pages still load. To change the secret: make a new one,
update `.env`, `npx vercel env rm ORIGIN_SECRET production`, add the new one,
and deploy again.

## Safety

- Anyone with the Vercel address can use the test (it is sandbox data and fake
  flights). Share it only with testers; do not enter real passport numbers.
  To restrict it, turn on **Vercel Authentication** for production in the
  project's Settings → Deployment Protection.
- Do not set real payment, Duffel live, Twilio or WhatsApp keys while testing
  through the tunnel.
- When the real server exists, this whole setup is replaced by docs/DEPLOY.md.
  `AGENT_DEMO` is refused in production.

## Troubleshooting

| What you see | Cause and fix |
|---|---|
| Chat says the assistant is not available | `npm run dev` start line says `"agent":"unconfigured"`: `AGENT_DEMO=true` missing from `.env` |
| Every chat or page error, `curl` to ngrok `/healthz` fails | ngrok or `npm run dev` not running |
| `/healthz` works but the site's chat fails with 403 | The secret differs: same value in `.env` and Vercel, then `npx vercel deploy --prod` again so Vercel uses the new value |
| ngrok's "You are about to visit" page | You opened the ngrok address directly; use the Vercel address |
| Old look after a change | Rebuild (`npm run build:web …`) and deploy again |
