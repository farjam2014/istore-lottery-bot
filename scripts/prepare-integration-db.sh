#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

die() { printf 'ERROR: %s\\n' "$*" >&2; exit 1; }
valid_user() { [[ "$1" =~ ^ustore_ci_[A-Za-z0-9_]{1,22}$ ]]; }
valid_password() { [[ "$1" =~ ^[A-Za-z0-9_-]{32,128}$ ]]; }
quote_id() { printf '`%s`' "$1"; }

DB_NAME="${MYSQL_TEST_DATABASE:-}"
RESTORE_DB="${MYSQL_RESTORE_DATABASE:-}"
PREFLIGHT_DB="${MYSQL_PREFLIGHT_DATABASE:-}"
DRAW_GUARD_DB="${MYSQL_DRAW_GUARD_DATABASE:-}"
TEST_USER="${MYSQL_TEST_USER:-}"
TEST_PASSWORD="${MYSQL_TEST_PASSWORD:-}"
MIGRATION_USER="${MYSQL_MIGRATION_USER:-}"
MIGRATION_PASSWORD="${MYSQL_MIGRATION_PASSWORD:-}"
BACKUP_USER="${MYSQL_BACKUP_USER:-}"
BACKUP_PASSWORD="${MYSQL_BACKUP_PASSWORD:-}"
RESTORE_USER="${MYSQL_RESTORE_USER:-}"
RESTORE_PASSWORD="${MYSQL_RESTORE_PASSWORD:-}"
RESTORE_RUNTIME_USER="${MYSQL_RESTORE_RUNTIME_USER:-}"
RESTORE_RUNTIME_PASSWORD="${MYSQL_RESTORE_RUNTIME_PASSWORD:-}"
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
for db in "$DB_NAME" "$RESTORE_DB" "$PREFLIGHT_DB" "$DRAW_GUARD_DB"; do
  [[ "$db" != "$PRODUCTION_DB" ]] || die "Refusing to target the production database."
done
[[ "$DB_NAME" != "$RESTORE_DB" && "$DB_NAME" != "$PREFLIGHT_DB" && "$DB_NAME" != "$DRAW_GUARD_DB" && "$RESTORE_DB" != "$PREFLIGHT_DB" && "$RESTORE_DB" != "$DRAW_GUARD_DB" && "$PREFLIGHT_DB" != "$DRAW_GUARD_DB" ]] || die "All integration database names must be distinct."

ALL_USERS=("$TEST_USER" "$MIGRATION_USER" "$BACKUP_USER" "$RESTORE_USER" "$RESTORE_RUNTIME_USER" "$ADMIN_USER" "$READONLY_USER")
for user in "${ALL_USERS[@]}"; do
  valid_user "$user" || die "All integration usernames must use the dedicated ustore_ci_* namespace."
  [[ "$user" != "$APP_USER" && "$user" != "$APP_MIGRATION_USER" ]] || die "Integration identities must never reuse a production runtime or migration identity."
done
for ((i=0;i<${#ALL_USERS[@]};i++)); do
  for ((j=i+1;j<${#ALL_USERS[@]};j++)); do
    [[ "${ALL_USERS[i]}" != "${ALL_USERS[j]}" ]] || die "All integration MySQL identities must be distinct."
  done
done
for password in "$TEST_PASSWORD" "$MIGRATION_PASSWORD" "$BACKUP_PASSWORD" "$RESTORE_PASSWORD" "$RESTORE_RUNTIME_PASSWORD" "$ADMIN_PASSWORD" "$READONLY_PASSWORD"; do
  valid_password "$password" || die "All integration passwords must be 32-128 letters, digits, underscores, or hyphens."
done

mysql --protocol=socket -N -e "SELECT 1" >/dev/null 2>&1 || die "Root socket access to MySQL failed. Run this script as root."

# Never repurpose an existing MySQL account: it may belong to another environment.
for user in "${ALL_USERS[@]}"; do
  exists="$(mysql --protocol=socket -NBe "SELECT COUNT(*) FROM mysql.user WHERE User='$user'")"
  [[ "$exists" == "0" ]] || die "MySQL account $user already exists at one or more hosts; refusing to alter or reuse it."
done

for db in "$DB_NAME" "$RESTORE_DB" "$PREFLIGHT_DB" "$DRAW_GUARD_DB"; do
  mysql --protocol=socket -e "CREATE DATABASE IF NOT EXISTS $(quote_id "$db") CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
done

# All four schemas must be empty. Never reset or drop an existing fixture.
for db in "$DB_NAME" "$RESTORE_DB" "$PREFLIGHT_DB" "$DRAW_GUARD_DB"; do
  count="$(mysql --protocol=socket -NBe "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$db'")"
  [[ "$count" == "0" ]] || die "Fixture database $db is not empty. Inspect and clean it explicitly before retrying."
done

mysql --protocol=socket <<SQL
CREATE USER '$TEST_USER'@'127.0.0.1' IDENTIFIED BY '$TEST_PASSWORD';
CREATE USER '$MIGRATION_USER'@'127.0.0.1' IDENTIFIED BY '$MIGRATION_PASSWORD';
CREATE USER '$BACKUP_USER'@'127.0.0.1' IDENTIFIED BY '$BACKUP_PASSWORD';
CREATE USER '$RESTORE_USER'@'127.0.0.1' IDENTIFIED BY '$RESTORE_PASSWORD';
CREATE USER '$RESTORE_RUNTIME_USER'@'127.0.0.1' IDENTIFIED BY '$RESTORE_RUNTIME_PASSWORD';
CREATE USER '$ADMIN_USER'@'127.0.0.1' IDENTIFIED BY '$ADMIN_PASSWORD';
CREATE USER '$READONLY_USER'@'127.0.0.1' IDENTIFIED BY '$READONLY_PASSWORD';

GRANT SELECT, INSERT, UPDATE, DELETE ON $(quote_id "$DB_NAME").* TO '$TEST_USER'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, TRIGGER ON $(quote_id "$DB_NAME").* TO '$MIGRATION_USER'@'127.0.0.1';
GRANT SELECT, SHOW VIEW, TRIGGER ON $(quote_id "$DB_NAME").* TO '$BACKUP_USER'@'127.0.0.1';
GRANT TRIGGER ON $(quote_id "$RESTORE_DB").* TO '$MIGRATION_USER'@'127.0.0.1';
GRANT ALL PRIVILEGES ON $(quote_id "$RESTORE_DB").* TO '$RESTORE_USER'@'127.0.0.1';
GRANT SET_USER_ID ON *.* TO '$RESTORE_USER'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON $(quote_id "$RESTORE_DB").* TO '$RESTORE_RUNTIME_USER'@'127.0.0.1';

GRANT ALL PRIVILEGES ON $(quote_id "$DB_NAME").* TO '$ADMIN_USER'@'127.0.0.1';
GRANT ALL PRIVILEGES ON $(quote_id "$RESTORE_DB").* TO '$ADMIN_USER'@'127.0.0.1';
GRANT ALL PRIVILEGES ON $(quote_id "$PREFLIGHT_DB").* TO '$ADMIN_USER'@'127.0.0.1';
GRANT ALL PRIVILEGES ON $(quote_id "$DRAW_GUARD_DB").* TO '$ADMIN_USER'@'127.0.0.1';
GRANT SELECT ON $(quote_id "$PREFLIGHT_DB").* TO '$READONLY_USER'@'127.0.0.1';

-- The fixture administrator inspects grants in these system tables; no write access is granted.
GRANT SELECT ON mysql.user TO '$ADMIN_USER'@'127.0.0.1';
GRANT SELECT ON mysql.procs_priv TO '$ADMIN_USER'@'127.0.0.1';
GRANT SELECT ON mysql.role_edges TO '$ADMIN_USER'@'127.0.0.1';
GRANT SELECT ON mysql.default_roles TO '$ADMIN_USER'@'127.0.0.1';
GRANT SELECT ON mysql.proxies_priv TO '$ADMIN_USER'@'127.0.0.1';
SQL

printf 'Dedicated integration schemas provisioned; all four schemas were verified empty.\\n'
printf 'Test schema: %s\\nRestore schema: %s\\nPreflight schema: %s\\nDraw-guard schema: %s\\n' "$DB_NAME" "$RESTORE_DB" "$PREFLIGHT_DB" "$DRAW_GUARD_DB"
printf 'Dedicated identities: test=%s migration=%s backup=%s restore=%s restore-runtime=%s fixture-admin=%s read-only=%s\\n' "$TEST_USER" "$MIGRATION_USER" "$BACKUP_USER" "$RESTORE_USER" "$RESTORE_RUNTIME_USER" "$ADMIN_USER" "$READONLY_USER"
printf 'Restore-only identity receives temporary SET_USER_ID on the local test MySQL instance; no production database or identity is modified.\\n'
