#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

DB_NAME="${MYSQL_TEST_DATABASE:-ustore_bot_ci}"
[[ "$DB_NAME" =~ ^[A-Za-z0-9_]+_ci$ ]] || die "Test database name must end in _ci and contain only letters, digits, and underscores."

APP_USER="$(node --input-type=module -e "import 'dotenv/config'; process.stdout.write(process.env.MYSQL_USER || '')")"
PRODUCTION_DB="$(node --input-type=module -e "import 'dotenv/config'; process.stdout.write(process.env.MYSQL_DATABASE || '')")"

[[ -n "$APP_USER" ]] || die "MYSQL_USER is missing from .env."
[[ "$APP_USER" =~ ^[A-Za-z0-9_]+$ ]] || die "MYSQL_USER contains unsupported characters."
[[ "$DB_NAME" != "$PRODUCTION_DB" ]] || die "Refusing to use the production database as the integration-test database."

mysql --protocol=socket -N -e "SELECT 1" >/dev/null 2>&1 || die "Root socket access to MySQL failed. Run this script as root."

mysql --protocol=socket -e "CREATE DATABASE IF NOT EXISTS `$DB_NAME` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

mapfile -t HOSTS < <(mysql --protocol=socket -N -e "SELECT Host FROM mysql.user WHERE User='\$APP_USER'")
(("${#HOSTS[@]}" > 0)) || die "No MySQL account exists for the configured application user."

for host in "${HOSTS[@]}"; do
  [[ "$host" =~ ^[A-Za-z0-9_.:%-]+$ ]] || die "Unexpected MySQL host value; refusing to build a GRANT statement."
  mysql --protocol=socket -e "GRANT ALL PRIVILEGES ON `$DB_NAME`.* TO '$APP_USER'@'$host';"
done

printf 'Integration database is ready: %s\n' "$DB_NAME"
printf 'Production database was not modified: %s\n' "$PRODUCTION_DB"
printf 'No database was dropped or cleared.\n'
