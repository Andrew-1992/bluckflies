# Test BluckFlies from your PC: ngrok + Vercel

A temporary setup for showing and testing BluckFlies on real phones before
the production server and the Anthropic key exist.

```
GitHub ──push──▶ Vercel builds web-dist/

phone ──https──▶ Vercel (web pages, icons, fonts)
                    │  /api/…, /e/…, /terms, /privacy, /refunds
                    │  + x-origin-secret header
                    ▼
                 ngrok (free tunnel) ──▶ your PC: npm run dev (port 3000)
```

- **Vercel** builds the web client from GitHub, serves it, and forwards everything dynamic to your PC.
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

## 4. Vercel from GitHub (first time)

Vercel builds the web client from your GitHub repository on every push to
`main`. The repository's `vercel.json` makes it a plain static site
(framework "Other", output `web-dist`), so the Express server is never deployed
to Vercel. The address of your PC and the secret are Vercel environment
variables, never in the repository.

1. Push the latest code to GitHub (`git add .`, `git commit -m "…"`, `git push`).
2. Vercel dashboard → **Add New… → Project** → **Import** `Andrew-1992/bluckflies`
   (first time: **Install** the Vercel GitHub app and allow that repository).
3. On the configure screen:
   - **Project name:** e.g. `bluckflies-web`.
   - **Framework Preset:** leave it; `vercel.json` sets "Other" and the build
     and output settings (`npm run build:web -- --from-env`, `web-dist`).
   - **Environment Variables**, add both:

     | Name | Value |
     |---|---|
     | `BLUCKFLIES_API_URL` | your ngrok address, e.g. `https://sneak-anteater-tarantula.ngrok-free.dev` (no `/` at the end) |
     | `ORIGIN_SECRET` | the secret from `.env` (`Select-String ORIGIN_SECRET .env`, the part after `=`) |

4. **Deploy.** The build log ends with `Built web-dist (version …). Server paths go to https://…ngrok-free.dev`.
5. Open the project's address (e.g. `https://bluckflies-web.vercel.app`) on
   your phone. Type "Juba to Nairobi on 20 November".

**Optional:** put that address in `.env` as `PUBLIC_BASE_URL=https://bluckflies-web.vercel.app`
and restart `npm run dev`, so e-ticket and payment links point at it.
(Link previews already use it: the build reads it from Vercel.)

## 5. After a change

- **Web client** (`public/`): `git push`. Vercel rebuilds by itself.
- **Server** (`src/`): `npm run dev` reloads by itself; nothing to deploy.
- **Changed `BLUCKFLIES_API_URL` or `ORIGIN_SECRET` in Vercel:** Deployments →
  latest → **Redeploy**, so it uses the new values.
- **Changed `src/http/staticSite.ts`** (routes or headers): run
  `npm run build:web -- --write-vercel-json` and commit `vercel.json` (a test
  fails until you do).

### Alternative: upload from your PC instead of GitHub

```powershell
npm run build:web -- --api https://example-name.ngrok-free.app
cd web-dist
npx vercel link                              # new project; settings "Other", no build command
npx vercel env add ORIGIN_SECRET production
npx vercel deploy --prod
cd ..
```

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
| `/healthz` works but the site's chat fails with 403 | The secret differs: same value in `.env` and Vercel, then **Redeploy** in Vercel so it uses the new value |
| Vercel build fails: "Set BLUCKFLIES_API_URL" | Add it in the project's Settings → Environment Variables, then Redeploy |
| Vercel build fails: "No entrypoint found which imports express" | The project was created before `vercel.json` was in the repository: push the latest code and Redeploy |
| ngrok's "You are about to visit" page | You opened the ngrok address directly; use the Vercel address |
| Old look after a change | Check the latest Vercel deployment finished (Deployments tab), then reload the page |
