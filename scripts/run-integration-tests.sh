#!/usr/bin/env bash
set -Eeuo pipefail

die(){ printf 'ERROR: %s\n' "$*" >&2; exit 1; }
read_dotenv_value(){ node --input-type=module -e "import 'dotenv/config';process.stdout.write(process.env.$1??'')"; }

TEST_DB="${MYSQL_TEST_DATABASE:-}"
RESTORE_DB="${MYSQL_RESTORE_DATABASE:-}"
PREFLIGHT_DB="${MYSQL_PREFLIGHT_DATABASE:-}"
DRAW_GUARD_DB="${MYSQL_DRAW_GUARD_DATABASE:-}"
APP_DB="$(read_dotenv_value MYSQL_DATABASE)"
APP_USER="$(read_dotenv_value MYSQL_USER)"
HOST="${MYSQL_HOST:-$(read_dotenv_value MYSQL_HOST)}"
HOST="${HOST:-127.0.0.1}"
TEST_USER="${MYSQL_TEST_USER:-}"
TEST_PASSWORD="${MYSQL_TEST_PASSWORD:-}"
ADMIN_USER="${MYSQL_TEST_ADMIN_USER:-}"
ADMIN_PASSWORD="${MYSQL_TEST_ADMIN_PASSWORD:-}"
READONLY_USER="${MYSQL_TEST_READONLY_USER:-}"
READONLY_PASSWORD="${MYSQL_TEST_READONLY_PASSWORD:-}"

[[ "$TEST_DB" =~ ^[A-Za-z0-9_]+_ci$ ]] || die "Set MYSQL_TEST_DATABASE to a dedicated _ci database."
[[ "$RESTORE_DB" =~ ^draw_restore_[A-Za-z0-9_]+_ci$ ]] || die "Set MYSQL_RESTORE_DATABASE to a pre-provisioned draw_restore_*_ci database."
[[ "$PREFLIGHT_DB" =~ ^ustore_preflight_[A-Za-z0-9_]+_ci$ ]] || die "Set MYSQL_PREFLIGHT_DATABASE to a pre-provisioned ustore_preflight_*_ci database."
[[ "$DRAW_GUARD_DB" =~ ^ustore_drawguard_[A-Za-z0-9_]+_ci$ ]] || die "Set MYSQL_DRAW_GUARD_DATABASE to a pre-provisioned ustore_drawguard_*_ci database."
[[ -n "$APP_DB" && -n "$APP_USER" ]] || die "Production database identity is missing from .env."
[[ "$TEST_DB" != "$APP_DB" && "$RESTORE_DB" != "$APP_DB" && "$PREFLIGHT_DB" != "$APP_DB" && "$DRAW_GUARD_DB" != "$APP_DB" ]] || die "Refusing to run tests against a production database."
[[ "$HOST" =~ ^(127\.0\.0\.1|localhost|::1)$ ]] || die "Integration tests are restricted to loopback MySQL."
[[ -n "$TEST_USER" && -n "$TEST_PASSWORD" && -n "$ADMIN_USER" && -n "$ADMIN_PASSWORD" && -n "$READONLY_USER" && -n "$READONLY_PASSWORD" ]] || die "Dedicated test, fixture-admin, and read-only credentials are all required."
[[ "$TEST_USER" != "$APP_USER" && "$ADMIN_USER" != "$APP_USER" && "$READONLY_USER" != "$APP_USER" ]] || die "Refusing to reuse the production MySQL identity."
[[ "$TEST_USER" != "$ADMIN_USER" && "$TEST_USER" != "$READONLY_USER" && "$ADMIN_USER" != "$READONLY_USER" ]] || die "Test identities must be distinct."
[[ "$TEST_DB" != "$RESTORE_DB" && "$TEST_DB" != "$PREFLIGHT_DB" && "$TEST_DB" != "$DRAW_GUARD_DB" && "$RESTORE_DB" != "$PREFLIGHT_DB" && "$RESTORE_DB" != "$DRAW_GUARD_DB" && "$PREFLIGHT_DB" != "$DRAW_GUARD_DB" ]] || die "Integration database names must be distinct."

export MYSQL_DATABASE="$TEST_DB"
export MYSQL_USER="$TEST_USER"
export MYSQL_PASSWORD="$TEST_PASSWORD"
export MYSQL_TEST_ADMIN_USER="$ADMIN_USER"
export MYSQL_TEST_ADMIN_PASSWORD="$ADMIN_PASSWORD"
export MYSQL_TEST_READONLY_USER="$READONLY_USER"
export MYSQL_TEST_READONLY_PASSWORD="$READONLY_PASSWORD"
export NODE_ENV=test
export ALLOW_DATABASE_MIGRATIONS=1
export ALLOW_TEST_DATABASE_MIGRATIONS=1
export RUN_MYSQL_TESTS=1

printf 'Running integration tests against dedicated schema: %s\n' "$MYSQL_DATABASE"
printf 'Fixture schemas: %s, %s, %s\n' "$MYSQL_RESTORE_DATABASE" "$MYSQL_PREFLIGHT_DATABASE" "$MYSQL_DRAW_GUARD_DATABASE"
printf 'Production database is not used: %s\n' "$APP_DB"
printf 'Production MySQL identity is not used.\n'
node --test --test-timeout=600000 --test-concurrency=1 tests/integration/mysql.test.js
node --test --test-timeout=600000 --test-concurrency=1 tests/integration/draw-keyring-backup-restore.test.js
node --test --test-timeout=600000 --test-concurrency=1 tests/integration/production-preflight-baseline.test.js
