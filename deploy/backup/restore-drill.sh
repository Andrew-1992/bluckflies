#!/bin/sh
# Proves a backup can be restored, without touching the live database: restores it
# into a scratch database in the same PostgreSQL container, prints row counts, and
# drops the scratch database. Run monthly, and after any change to backups.
#
#   deploy/backup/restore-drill.sh ~/backups/bluckflies/bluckflies-<stamp>.dump.age ~/bluckflies-backup.key
#
# The second argument is the age PRIVATE key file. Keep it off the server; copy it
# in for the drill and delete it afterwards.
set -eu

file="${1:?usage: restore-drill.sh <backup.dump.age> <age-identity-file>}"
identity="${2:?usage: restore-drill.sh <backup.dump.age> <age-identity-file>}"
db=bluckflies_restore_drill

psql() { docker compose exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

psql -d postgres -c "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db"
trap 'psql -d postgres -c "DROP DATABASE IF EXISTS $db" >/dev/null 2>&1 || true' EXIT

age -d -i "$identity" "$file" \
  | docker compose exec -T postgres pg_restore -U postgres -d "$db" --no-owner --no-privileges --exit-on-error

echo "restore-drill: restored $file"
psql -d "$db" -At -F " " -c "
  SELECT 'bookings', count(*) FROM bookings
  UNION ALL SELECT 'payments', count(*) FROM payments
  UNION ALL SELECT 'support_tickets', count(*) FROM support_tickets
  UNION ALL SELECT 'staff_users', count(*) FROM staff_users"
psql -d "$db" -At -c "SELECT 'latest booking at ' || coalesce(max(created_at)::text, 'none') FROM bookings"
echo "restore-drill: OK (scratch database dropped on exit)"
