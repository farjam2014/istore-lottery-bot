#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
valid_user() { [[ "$1" =~ ^ustore_ci_[A-Za-z0-9_]{1,22}$ ]]; }
valid_password() { [[ "$1" =~ ^[A-Za-z0-9_-]{32,128}$ ]]; }
quote_id() { printf '`%s`' "$1"; }

DB_NAME="${MYSQL_TEST_DATABASE:-}"
RESTORE_DB="${MYSQL_RESTORE_DATABASE:-}"
PREFLIGHT_DB="${MYSQL_PREFLIGHT_DATABASE:-}"
DRAW_GUARD_DB="${MYSQL_DRAW_GUARD_DATABASE:-}"
TEST_USER="${MYSQL_TEST_USER:-}"
TEST_PASSWORD="${MYSQL_TEST_PASSWORD:-}"
ADMIN_USER="${MYSQL_TEST_ADMIN_USER:-}"
ADMIN_PASSWORD="${MYSQL_TEST_ADMIN_PASSWORD:-}"
READONLY_USER="${MYSQL_TEST_READONLY_USER:-}"
READONLY_PASSWORD="${MYSQL_TEST_READONLY_PASSWORD:-}"

APP_USER="$(node --input-type=module -e "import 'dotenv/config'; process.stdout.write(process.env.MYSQL_USER || '')")"
APP_MIGRATION_USER="$(node --input-type=module -e "import 'dotenv/config'; process.stdout.write(process.env.MYSQL_MIGRATION_USER || '')")"
PRODUCTION_DB="$(node --input-type=module -e "import 'dotenv/config'; process.stdout.write(process.env.MYSQL_DATABASE || '')")"

[[ "$DB_NAME" =~ ^[A-Za-z0-9_]+_ci$ ]] || die "Set MYSQL_TEST_DATABASE to a dedicated _ci database."
[[ "$RESTORE_DB" =~ ^draw_restore_[A-Za-z0-9_]+_ci$ ]] || die "Set MYSQL_RESTORE_DATABASE to a dedicated draw_restore_*_ci database."
[[ "$PREFLIGHT_DB" =~ ^ustore_preflight_[A-Za-z0-9_]+_ci$ ]] || die "Set MYSQL_PREFLIGHT_DATABASE to a dedicated ustore_preflight_*_ci database."
[[ "$DRAW_GUARD_DB" =~ ^ustore_drawguard_[A-Za-z0-9_]+_ci$ ]] || die "Set MYSQL_DRAW_GUARD_DATABASE to a dedicated ustore_drawguard_*_ci database."
[[ -n "$PRODUCTION_DB" && -n "$APP_USER" ]] || die "Could not read the production database identity from .env."
[[ "$DB_NAME" != "$PRODUCTION_DB" && "$RESTORE_DB" != "$PRODUCTION_DB" && "$PREFLIGHT_DB" != "$PRODUCTION_DB" && "$DRAW_GUARD_DB" != "$PRODUCTION_DB" ]] || die "Refusing to target the production database."
[[ "$DB_NAME" != "$RESTORE_DB" && "$DB_NAME" != "$PREFLIGHT_DB" && "$DB_NAME" != "$DRAW_GUARD_DB" && "$RESTORE_DB" != "$PREFLIGHT_DB" && "$RESTORE_DB" != "$DRAW_GUARD_DB" && "$PREFLIGHT_DB" != "$DRAW_GUARD_DB" ]] || die "All integration database names must be distinct."

for user in "$TEST_USER" "$ADMIN_USER" "$READONLY_USER"; do
  valid_user "$user" || die "Test usernames must contain 1-32 letters, digits, or underscores."
  [[ "$user" != "$APP_USER" && "$user" != "$APP_MIGRATION_USER" ]] || die "Test identities must never reuse a production runtime or migration identity."
done
[[ "$TEST_USER" != "$ADMIN_USER" && "$TEST_USER" != "$READONLY_USER" && "$ADMIN_USER" != "$READONLY_USER" ]] || die "Test, fixture-admin, and read-only identities must be distinct."
valid_password "$TEST_PASSWORD" || die "MYSQL_TEST_PASSWORD must be 32-128 letters, digits, underscores, or hyphens."
valid_password "$ADMIN_PASSWORD" || die "MYSQL_TEST_ADMIN_PASSWORD must be 32-128 letters, digits, underscores, or hyphens."
valid_password "$READONLY_PASSWORD" || die "MYSQL_TEST_READONLY_PASSWORD must be 32-128 letters, digits, underscores, or hyphens."

mysql --protocol=socket -N -e "SELECT 1" >/dev/null 2>&1 || die "Root socket access to MySQL failed. Run this script as root."

# Never repurpose an existing MySQL account: it may belong to another environment.
for user in "$TEST_USER" "$ADMIN_USER" "$READONLY_USER"; do
  exists="$(mysql --protocol=socket -NBe "SELECT COUNT(*) FROM mysql.user WHERE User='$user'")"
  [[ "$exists" == "0" ]] || die "MySQL account $user@127.0.0.1 already exists; refusing to alter or reuse it."
done

for db in "$DB_NAME" "$RESTORE_DB" "$PREFLIGHT_DB" "$DRAW_GUARD_DB"; do
  mysql --protocol=socket -e "CREATE DATABASE IF NOT EXISTS $(quote_id "$db") CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
done

# These schemas are intentionally reusable only when empty. Never reset or drop them here.
for db in "$RESTORE_DB" "$PREFLIGHT_DB" "$DRAW_GUARD_DB"; do
  count="$(mysql --protocol=socket -NBe "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$db'")"
  [[ "$count" == "0" ]] || die "Fixture database $db is not empty. Inspect and clean it explicitly before retrying."
done

mysql --protocol=socket <<SQL
CREATE USER '$TEST_USER'@'127.0.0.1' IDENTIFIED BY '$TEST_PASSWORD';
CREATE USER '$ADMIN_USER'@'127.0.0.1' IDENTIFIED BY '$ADMIN_PASSWORD';
CREATE USER '$READONLY_USER'@'127.0.0.1' IDENTIFIED BY '$READONLY_PASSWORD';

GRANT ALL PRIVILEGES ON $(quote_id "$DB_NAME").* TO '$TEST_USER'@'127.0.0.1';
GRANT ALL PRIVILEGES ON $(quote_id "$DB_NAME").* TO '$ADMIN_USER'@'127.0.0.1';
GRANT ALL PRIVILEGES ON $(quote_id "$RESTORE_DB").* TO '$ADMIN_USER'@'127.0.0.1';
GRANT ALL PRIVILEGES ON $(quote_id "$PREFLIGHT_DB").* TO '$ADMIN_USER'@'127.0.0.1';
GRANT ALL PRIVILEGES ON $(quote_id "$DRAW_GUARD_DB").* TO '$ADMIN_USER'@'127.0.0.1';
GRANT SELECT ON $(quote_id "$PREFLIGHT_DB").* TO '$READONLY_USER'@'127.0.0.1';
SQL

printf 'Dedicated integration schemas provisioned.\n'
printf 'Test schema: %s\nRestore schema: %s\nPreflight schema: %s\nDraw-guard schema: %s\n' "$DB_NAME" "$RESTORE_DB" "$PREFLIGHT_DB" "$DRAW_GUARD_DB"
printf 'Dedicated identities: test=%s fixture-admin=%s read-only=%s\n' "$TEST_USER" "$ADMIN_USER" "$READONLY_USER"
printf 'No global privileges were granted; production database and production identity were not modified.\n'
