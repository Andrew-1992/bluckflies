#!/bin/sh
# Creates the BluckFlies database with two least-privilege roles.
# Runs once, on first start of an empty Postgres data volume
# (mounted into /docker-entrypoint-initdb.d by docker-compose.yml).
#
#   bluckflies_owner  owns the database and schema; used ONLY by migrations.
#   bluckflies_app    used by the running app; may read and write rows in
#                     tables the owner creates, but cannot create, alter or
#                     drop anything.
set -eu

: "${BLUCKFLIES_OWNER_PASSWORD:?BLUCKFLIES_OWNER_PASSWORD is required}"
: "${BLUCKFLIES_APP_PASSWORD:?BLUCKFLIES_APP_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner_pw="$BLUCKFLIES_OWNER_PASSWORD" \
  -v app_pw="$BLUCKFLIES_APP_PASSWORD" <<'SQL'
CREATE ROLE bluckflies_owner LOGIN PASSWORD :'owner_pw';
CREATE ROLE bluckflies_app LOGIN PASSWORD :'app_pw';
CREATE DATABASE bluckflies OWNER bluckflies_owner;
REVOKE ALL ON DATABASE bluckflies FROM PUBLIC;
GRANT CONNECT ON DATABASE bluckflies TO bluckflies_app;

\connect bluckflies
-- Postgres 15+: only the database owner may create objects in "public".
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO bluckflies_app;
-- Every table/sequence the owner creates in future migrations is usable by the app.
ALTER DEFAULT PRIVILEGES FOR ROLE bluckflies_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bluckflies_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bluckflies_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO bluckflies_app;
SQL
