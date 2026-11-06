#!/bin/sh
# Disaster recovery: REPLACES the live BluckFlies database with a backup.
# Run from the project folder. Everything written since the backup is lost.
#
#   deploy/backup/restore.sh ~/backups/bluckflies/bluckflies-<stamp>.dump.age ~/bluckflies-backup.key
#
# Steps: stop the app, decrypt, recreate the database with the same access rules
# as deploy/postgres/init-roles.sh (dropping a database loses its grants), restore,
# then start everything (migrations run first). Use the restore drill to test
# backups; use this only to recover.
set -eu
umask 077

file="${1:?usage: restore.sh <backup.dump.age> <age-identity-file>}"
identity="${2:?usage: restore.sh <backup.dump.age> <age-identity-file>}"
[ -f "$file" ] || { echo "restore: no such file $file" >&2; exit 1; }

if [ "${RESTORE_CONFIRM:-}" != "yes" ]; then
  printf 'This REPLACES the live database with %s. Type RESTORE to continue: ' "$file"
  read -r answer
  [ "$answer" = "RESTORE" ] || { echo "restore: cancelled"; exit 1; }
fi

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
# Decrypt first: a wrong key or damaged file stops here, before anything is touched.
age -d -i "$identity" "$file" > "$tmp"

docker compose stop app
docker compose exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 -q \
  -c "DROP DATABASE IF EXISTS bluckflies WITH (FORCE)" \
  -c "CREATE DATABASE bluckflies OWNER bluckflies_owner" \
  -c "REVOKE ALL ON DATABASE bluckflies FROM PUBLIC" \
  -c "GRANT CONNECT ON DATABASE bluckflies TO bluckflies_app"
# Schema and table privileges, and the default privileges for future tables, are in the dump.
docker compose exec -T postgres pg_restore -U postgres -d bluckflies --exit-on-error < "$tmp"
echo "restore: database restored from $file"

docker compose up -d
echo "restore: services started. Check: docker compose ps, then /readyz, then the desk."
