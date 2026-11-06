#!/bin/sh
# Encrypted PostgreSQL backup for BluckFlies. Run daily from cron in the project
# folder, e.g.:   15 2 * * * cd /opt/bluckflies && deploy/backup/backup.sh >> /var/log/bluckflies-backup.log 2>&1
#
# Needs:  age (https://age-encryption.org) and BACKUP_AGE_RECIPIENT, the PUBLIC key
#         of a key pair whose private key is NOT on this server.
# Optional: BACKUP_DIR (default ~/backups/bluckflies), BACKUP_KEEP_DAYS (default 14),
#           BACKUP_RCLONE_REMOTE (e.g. b2:bluckflies-backups) to copy each backup off the server.
#
# The dump keeps passenger details encrypted as stored (AES-256-GCM columns): a
# restore needs the same DATA_ENCRYPTION_KEYS, kept separately in your password manager.
set -eu
umask 077  # backups readable by their owner only

# Settings may live in .env (run from the project folder). Only BACKUP_* lines are
# read, and never executed: .env holds values like CASH_OFFICES with "|" in them.
if [ -f .env ]; then
  for line in $(grep -E '^BACKUP_(AGE_RECIPIENT|DIR|KEEP_DAYS|RCLONE_REMOTE)=[^[:space:]]+$' .env || true); do
    key=${line%%=*}
    [ -n "$(printenv "$key" || true)" ] || export "$line"   # the environment wins over .env
  done
fi

: "${BACKUP_AGE_RECIPIENT:?set BACKUP_AGE_RECIPIENT to the age public key (age1...)}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/bluckflies}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
command -v age >/dev/null || { echo "backup: age is not installed" >&2; exit 1; }

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
out="$BACKUP_DIR/bluckflies-$stamp.dump.age"
tmp="$out.partial"

# Custom format: compressed, and restorable table by table with pg_restore.
docker compose exec -T postgres pg_dump -U postgres -d bluckflies --format=custom \
  | age -r "$BACKUP_AGE_RECIPIENT" > "$tmp"

# An empty or tiny file means the dump failed (pipe errors are not caught by sh).
size=$(wc -c < "$tmp")
if [ "$size" -lt 1024 ]; then
  rm -f "$tmp"
  echo "backup: FAILED, dump is only $size bytes" >&2
  exit 1
fi
mv "$tmp" "$out"
echo "backup: wrote $out ($size bytes)"

if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
  rclone copy "$out" "$BACKUP_RCLONE_REMOTE" && echo "backup: copied to $BACKUP_RCLONE_REMOTE"
fi

find "$BACKUP_DIR" -name 'bluckflies-*.dump.age' -mtime +"$KEEP_DAYS" -delete
