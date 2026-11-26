#!/usr/bin/env bash
set -Eeuo pipefail

die(){ printf 'ERROR: %s\\n' "$*" >&2; exit 1; }
read_dotenv_value(){ node --input-type=module -e "import dotenv from 'dotenv';import {existsSync,readFileSync} from 'node:fs';const values=existsSync('.env')?dotenv.parse(readFileSync('.env')):process.env;process.stdout.write(values[process.argv[1]]??'')" "$1"; }
valid_user(){ [[ "$1" =~ ^ustore_ci_[A-Za-z0-9_]{1,22}$ ]]; }
valid_password(){ [[ "$1" =~ ^[A-Za-z0-9_-]{32,128}$ ]]; }

TEST_DB="${MYSQL_TEST_DATABASE:-}"
RESTORE_DB="${MYSQL_RESTORE_DATABASE:-}"
PREFLIGHT_DB="${MYSQL_PREFLIGHT_DATABASE:-}"
DRAW_GUARD_DB="${MYSQL_DRAW_GUARD_DATABASE:-}"
APP_DB="$(read_dotenv_value MYSQL_DATABASE)"
APP_USER="$(read_dotenv_value MYSQL_USER)"
APP_MIGRATION_USER="$(read_dotenv_value MYSQL_MIGRATION_USER)"
HOST="${MYSQL_HOST:-$(read_dotenv_value MYSQL_HOST)}"
HOST="${HOST:-127.0.0.1}"
PORT="${MYSQL_PORT:-$(read_dotenv_value MYSQL_PORT)}"
PORT="${PORT:-3306}"

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
DRAW_KEY="${DRAW_SEED_ENCRYPTION_KEY:-}"

[[ "$TEST_DB" =~ ^[A-Za-z0-9_]+_ci$ ]] || die "Set MYSQL_TEST_DATABASE to a dedicated _ci database."
[[ "$RESTORE_DB" =~ ^draw_restore_[A-Za-z0-9_]+_ci$ ]] || die "Set MYSQL_RESTORE_DATABASE to a pre-provisioned draw_restore_*_ci database."
[[ "$PREFLIGHT_DB" =~ ^ustore_preflight_[A-Za-z0-9_]+_ci$ ]] || die "Set MYSQL_PREFLIGHT_DATABASE to a pre-provisioned ustore_preflight_*_ci database."
[[ "$DRAW_GUARD_DB" =~ ^ustore_drawguard_[A-Za-z0-9_]+_ci$ ]] || die "Set MYSQL_DRAW_GUARD_DATABASE to a pre-provisioned ustore_drawguard_*_ci database."
[[ -n "$APP_DB" && -n "$APP_USER" ]] || die "Production database identity is missing from .env."
for db in "$TEST_DB" "$RESTORE_DB" "$PREFLIGHT_DB" "$DRAW_GUARD_DB"; do
  [[ "$db" != "$APP_DB" ]] || die "Refusing to run tests against the production database."
done
[[ "$HOST" =~ ^(127\\.0\\.0\\.1|localhost|::1)$ ]] || die "Integration tests are restricted to loopback MySQL."
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] && ((PORT>=1 && PORT<=65535)) || die "MYSQL_PORT must be a valid TCP port."

ALL_USERS=("$TEST_USER" "$MIGRATION_USER" "$BACKUP_USER" "$RESTORE_USER" "$RESTORE_RUNTIME_USER" "$ADMIN_USER" "$READONLY_USER")
for user in "${ALL_USERS[@]}"; do
  valid_user "$user" || die "All integration usernames must use the dedicated ustore_ci_* namespace."
  [[ "$user" != "$APP_USER" && "$user" != "$APP_MIGRATION_USER" ]] || die "Refusing to reuse a production runtime or migration identity."
done
for ((i=0;i<${#ALL_USERS[@]};i++)); do
  for ((j=i+1;j<${#ALL_USERS[@]};j++)); do
    [[ "${ALL_USERS[i]}" != "${ALL_USERS[j]}" ]] || die "All integration MySQL identities must be distinct."
  done
done
for password in "$TEST_PASSWORD" "$MIGRATION_PASSWORD" "$BACKUP_PASSWORD" "$RESTORE_PASSWORD" "$RESTORE_RUNTIME_PASSWORD" "$ADMIN_PASSWORD" "$READONLY_PASSWORD"; do
  valid_password "$password" || die "All integration passwords must be 32-128 letters, digits, underscores, or hyphens."
done
[[ "$DRAW_KEY" =~ ^[A-Fa-f0-9]{64}$ ]] || die "DRAW_SEED_ENCRYPTION_KEY must be a disposable 64-character hex test key."
[[ "$TEST_DB" != "$RESTORE_DB" && "$TEST_DB" != "$PREFLIGHT_DB" && "$TEST_DB" != "$DRAW_GUARD_DB" && "$RESTORE_DB" != "$PREFLIGHT_DB" && "$RESTORE_DB" != "$DRAW_GUARD_DB" && "$PREFLIGHT_DB" != "$DRAW_GUARD_DB" ]] || die "Integration database names must be distinct."

export MYSQL_HOST="$HOST"
export MYSQL_PORT="$PORT"
export MYSQL_DATABASE="$TEST_DB"
export MYSQL_USER="$TEST_USER"
export MYSQL_PASSWORD="$TEST_PASSWORD"
export MYSQL_MIGRATION_USER="$MIGRATION_USER"
export MYSQL_MIGRATION_PASSWORD="$MIGRATION_PASSWORD"
export MYSQL_BACKUP_USER="$BACKUP_USER"
export MYSQL_BACKUP_PASSWORD="$BACKUP_PASSWORD"
export MYSQL_RESTORE_USER="$RESTORE_USER"
export MYSQL_RESTORE_PASSWORD="$RESTORE_PASSWORD"
export MYSQL_RESTORE_RUNTIME_USER="$RESTORE_RUNTIME_USER"
export MYSQL_RESTORE_RUNTIME_PASSWORD="$RESTORE_RUNTIME_PASSWORD"
export MYSQL_TEST_ADMIN_USER="$ADMIN_USER"
export MYSQL_TEST_ADMIN_PASSWORD="$ADMIN_PASSWORD"
export MYSQL_TEST_READONLY_USER="$READONLY_USER"
export MYSQL_TEST_READONLY_PASSWORD="$READONLY_PASSWORD"
export MYSQL_RESTORE_DATABASE="$RESTORE_DB"
export MYSQL_PREFLIGHT_DATABASE="$PREFLIGHT_DB"
export MYSQL_DRAW_GUARD_DATABASE="$DRAW_GUARD_DB"
export DRAW_SEED_ENCRYPTION_KEY="$DRAW_KEY"
export NODE_ENV=test
export ALLOW_DATABASE_MIGRATIONS=1
export ALLOW_TEST_DATABASE_MIGRATIONS=1
export RUN_MYSQL_TESTS=1

# The separate privilege-matrix fixture is CI-only; never inherit similarly named
# values from a developer's .env and accidentally target an unrelated schema.
unset MYSQL_PRIVILEGE_TEST_DATABASE MYSQL_PRIVILEGE_RUNTIME_USER MYSQL_PRIVILEGE_RUNTIME_PASSWORD MYSQL_PRIVILEGE_MIGRATION_USER MYSQL_PRIVILEGE_MIGRATION_PASSWORD || true

printf 'Running integration tests against dedicated schema: %s\\n' "$MYSQL_DATABASE"
printf 'Fixture schemas: %s, %s, %s\\n' "$MYSQL_RESTORE_DATABASE" "$MYSQL_PREFLIGHT_DATABASE" "$MYSQL_DRAW_GUARD_DATABASE"
printf 'Production database is not used: %s\\n' "$APP_DB"
printf 'Production runtime and migration identities are not used.\\n'
node --test --test-timeout=600000 --test-concurrency=1 tests/integration/mysql.test.js
node --test --test-timeout=600000 --test-concurrency=1 tests/integration/draw-keyring-backup-restore.test.js
node --test --test-timeout=600000 --test-concurrency=1 tests/integration/production-preflight-baseline.test.js
