# Deploying BluckFlies

This guide puts BluckFlies on one Linux server with Docker Compose: PostgreSQL,
the app, and Caddy for HTTPS. It covers backups, updates, monitoring and
recovery. Connecting the outside services (Claude, Duffel, payments, messages)
is in [CONNECT.md](CONNECT.md); the go-live list is in [LAUNCH.md](LAUNCH.md).

## 1. What you need

| Item | Recommendation |
|---|---|
| Server | Ubuntu 24.04 LTS, 2 vCPU, 4 GB RAM, 40 GB SSD. Choose a region with low latency to Juba, and a provider whose terms allow processing passenger data (list it in the privacy notice). |
| Domain | e.g. `bluckflies.com`, with an `A` record pointing at the server's IP. |
| Secrets store | A password manager (Bitwarden, 1Password) for `.env` values, the encryption keys and the backup private key. **Not** on the server only. |
| Off-site backup storage | Any S3-compatible bucket (Backblaze B2, Wasabi, AWS S3) reachable with `rclone`. |
| Uptime monitor | A free external monitor (UptimeRobot, Better Stack) that checks `/readyz` every minute. |

One server comfortably handles launch traffic. The app can run on several
servers later: rate limits, AI budgets and background-job leases are already
shared through the database.

## 2. Prepare the server

```bash
# As root, once
adduser deploy && usermod -aG sudo deploy
# Copy your SSH public key to /home/deploy/.ssh/authorized_keys, then:
sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/; s/^#\?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl reload ssh

apt update && apt -y upgrade && apt -y install unattended-upgrades ufw age rclone
dpkg-reconfigure -plow unattended-upgrades

ufw default deny incoming && ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp && ufw enable

# Docker Engine and the Compose plugin: follow https://docs.docker.com/engine/install/ubuntu/
usermod -aG docker deploy
```

PostgreSQL (5432) and the app (3000) bind to `127.0.0.1` only, so the firewall
never needs to open them. Note that Docker's own published ports can bypass
`ufw`; that is why everything except Caddy binds to localhost.

## 3. Install BluckFlies

```bash
sudo mkdir -p /opt/bluckflies && sudo chown deploy /opt/bluckflies
cd /opt/bluckflies
# copy the project here (git clone, or unzip the release)
cp .env.example .env && chmod 600 .env
```

Fill in `.env` (secret generation commands are in CONNECT.md section 2):

| Setting | Production value |
|---|---|
| `NODE_ENV` | `production` |
| `PUBLIC_BASE_URL` | `https://bluckflies.com` |
| `SITE_DOMAIN` | `bluckflies.com` (for Caddy) |
| `TRUST_PROXY_HOPS` | `1` (Caddy only). `2` if a cloud load balancer sits in front of Caddy. |
| `POSTGRES_PASSWORD`, `BLUCKFLIES_OWNER_PASSWORD`, `BLUCKFLIES_APP_PASSWORD` | Three different long random values. |
| `DATA_ENCRYPTION_KEYS`, `PAYMENT_WEBHOOK_SECRET`, `AUTH_SECRET` | Generated; **save copies in the password manager now.** |
| `FLIGHT_PROVIDER`, `DUFFEL_*`, payment, email, SMS, WhatsApp, Claude | Live keys, per CONNECT.md. |
| `LEGAL_COMPANY_*`, `SUPPORT_EMAIL`, `SUPPORT_PHONE` | Your company details for the legal pages and footer. |
| `ENABLE_SANDBOX_ENDPOINTS` | `false` (production refuses `true`). |

Every app setting in `.env` reaches the app container (`docker-compose.yml`
lists them all; a test fails if one is missing). The PostgreSQL superuser and
schema-owner passwords never reach the app: it connects as a role that can only
read and write rows.

## 4. Start

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.caddy.yml up -d --build
docker compose ps        # postgres healthy, migrate exited 0, app healthy, caddy up
curl -fsS https://bluckflies.com/readyz
```

On every start, the `migrate` service applies database migrations with the
schema-owner role, then exits; the app starts only after it succeeds. Caddy gets
the HTTPS certificate automatically on first request (ports 80 and 443 must be
reachable from the internet).

Then, inside the app container:

```bash
# First support-desk admin (asks for email, name and a password; then set up two-step login at /desk.html)
docker compose run --rm app node dist/cli/createAdmin.js

# Test every configured service with read-only calls, and print the webhook URLs to register
docker compose run --rm app node dist/cli/checkConnections.js
```

Register each webhook URL that `checkConnections` prints (Stripe or DPO, Duffel,
WhatsApp, Twilio) in that provider's dashboard.

## 5. Backups

Two things must be backed up, **separately**:

1. **The database**: encrypted nightly dumps (below).
2. **The keys**: `.env`, especially `DATA_ENCRYPTION_KEYS`. Passenger names,
   passports, phone numbers and chats are encrypted in the database with these
   keys. A database backup without the keys cannot be read; the keys without
   the backup are useless to an attacker. Keep them in the password manager,
   never next to the backups.

### Nightly encrypted dump

```bash
# On your own computer (not the server): create the backup key pair
age-keygen -o bluckflies-backup.key      # prints the public key "age1..."
# Store bluckflies-backup.key in the password manager. Put only the public key on the server:
echo 'BACKUP_AGE_RECIPIENT=age1...' >> /opt/bluckflies/.env

# Off-site copies (optional but strongly recommended): configure an rclone remote, then
echo 'BACKUP_RCLONE_REMOTE=b2:bluckflies-backups' >> /opt/bluckflies/.env
```

Add to the `deploy` user's crontab (`crontab -e`):

```cron
15 2 * * * cd /opt/bluckflies && deploy/backup/backup.sh >> /home/deploy/bluckflies-backup.log 2>&1
```

`deploy/backup/backup.sh` reads its `BACKUP_*` settings from `.env` (and nothing else), dumps the database (`pg_dump`, custom format),
encrypts it with `age` to the public key, refuses to keep a suspiciously small
dump, writes files readable only by their owner, copies to the off-site
remote, and deletes local copies older than `BACKUP_KEEP_DAYS` (14). Set the
bucket's own lifecycle rule to keep, for example, 30 daily and 12 monthly copies.

Also turn on your hosting provider's server snapshots (weekly) as a second layer.

### Restore drill (monthly)

A backup you have not restored is not a backup:

```bash
# Copy the private key to the server for the drill only
deploy/backup/restore-drill.sh ~/backups/bluckflies/bluckflies-<stamp>.dump.age ~/bluckflies-backup.key
shred -u ~/bluckflies-backup.key
```

It restores into a scratch database next to the live one, prints row counts
and the latest booking time, and drops the scratch database. Write the date and
counts in your operations log.

### Real restore (disaster recovery)

```bash
cd /opt/bluckflies
# copy the private key in from the password manager, then:
deploy/backup/restore.sh ~/backups/bluckflies/bluckflies-<stamp>.dump.age ~/bluckflies-backup.key
shred -u ~/bluckflies-backup.key
```

`restore.sh` asks you to type `RESTORE`, decrypts first (a wrong key or damaged
file stops it before anything changes), stops the app, recreates the database
with the same access rules as the original setup (only the app role may
connect), restores, and starts everything again; migrations run first.

On a brand-new server: install as in sections 2–4 with the **same** `.env`
(from the password manager), start only `postgres` (`docker compose up -d
postgres`) so it creates the roles, then run `restore.sh` as above.

Bookings made after the backup are lost: check the airline (Duffel dashboard)
and payment provider dashboards for orders and payments since the backup time,
and re-enter them with the support desk.

## 6. Updating

```bash
cd /opt/bluckflies
deploy/backup/backup.sh                  # fresh backup first
# get the new version (git pull, or unzip the release over the folder, keeping .env)
docker compose -f docker-compose.yml -f deploy/docker-compose.caddy.yml up -d --build
docker compose ps && curl -fsS https://bluckflies.com/readyz
```

The app stops gracefully (finishes requests in flight, up to 15 seconds).
Migrations only move forward: to undo a release whose migration broke
something, restore the backup taken just before the update and redeploy the
previous version. Before changing the AI model or system prompt, run
`npm run eval -- --repeat 3` on a development machine (CONNECT.md section 1b).

## 7. Monitoring and logs

- **Uptime:** the external monitor checks `https://bluckflies.com/readyz`
  (database reachable and migrated). Alert by SMS or email.
- **Operations alerts:** the app emails and texts `OPS_ALERT_EMAILS` /
  `OPS_ALERT_PHONES` for paid bookings not ticketed, refunds failing, Duffel
  balance low, the AI assistant down or over budget, and messages failing
  (RUNBOOKS.md section 6 says what to do for each).
- **Logs:** `docker compose logs -f app` (JSON lines). Container logs are capped
  at 5 × 10 MB per service. Caddy access logs (which contain visitors' internet
  addresses) are deleted after 14 days, as the privacy notice states.
- **Disk:** check monthly that backups and logs are not filling the disk (`df -h`).

## 8. Security checklist for the server

- SSH by key only, root login off, `unattended-upgrades` on.
- `.env` is `chmod 600` and owned by `deploy`; copies live only in the password manager.
- Only ports 22, 80 and 443 are open.
- Staff use personal desk accounts with two-step login (`STAFF_REQUIRE_2FA`
  defaults to on in production). `ADMIN_API_TOKEN` is for emergencies only;
  leave it blank or rotate it after use.
- Rotate a secret immediately if it may have leaked (RUNBOOKS.md section 7.3).
