#!/usr/bin/env bash
set -Eeuo pipefail

die(){ printf 'ERROR: %s\n' "$*" >&2; exit 1; }

TEST_DB="${MYSQL_TEST_DATABASE:-}"
APP_DB="${MYSQL_DATABASE:-}"
HOST="${MYSQL_HOST:-127.0.0.1}"
ADMIN_USER="${MYSQL_TEST_ADMIN_USER:-}"
ADMIN_PASSWORD="${MYSQL_TEST_ADMIN_PASSWORD:-${MYSQL_PASSWORD:-}}"

[[ "$TEST_DB" =~ ^[A-Za-z0-9_]+_(ci|test)$ ]] || die "Set MYSQL_TEST_DATABASE to an explicit disposable database ending in _ci or _test."
[[ -n "$APP_DB" ]] || die "MYSQL_DATABASE is missing; refusing to infer the application database."
[[ "$TEST_DB" != "$APP_DB" ]] || die "Refusing to run integration tests against MYSQL_DATABASE. Choose a separate MYSQL_TEST_DATABASE."
[[ "$HOST" =~ ^(127\.0\.0\.1|localhost|::1)$ ]] || die "Integration tests are restricted to loopback MySQL."
[[ -n "${MYSQL_USER:-}" ]] || die "MYSQL_USER is required."
[[ -n "$ADMIN_USER" ]] || die "Set MYSQL_TEST_ADMIN_USER for the isolated backup/restore test."
export MYSQL_DATABASE="$TEST_DB"
export NODE_ENV=test
export ALLOW_DATABASE_MIGRATIONS=1
export ALLOW_TEST_DATABASE_MIGRATIONS=1
export RUN_MYSQL_TESTS=1
export MYSQL_TEST_ADMIN_USER="$ADMIN_USER"
export MYSQL_TEST_ADMIN_PASSWORD="$ADMIN_PASSWORD"

printf 'Running integration tests against disposable database: %s\n' "$MYSQL_DATABASE"
printf 'Application database is not used: %s\n' "$APP_DB"
node --test --test-concurrency=1 tests/integration/mysql.test.js
node --test --test-concurrency=1 tests/integration/draw-keyring-backup-restore.test.js
