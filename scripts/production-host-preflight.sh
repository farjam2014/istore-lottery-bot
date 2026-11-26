#!/usr/bin/env bash
# Read-only host-side release gate inventory. Run as root from the staged candidate.
# Never prints .env values, passwords, bot tokens, or draw keys.
set -Eeuo pipefail
umask 077
FAILURES=0
fail(){ printf 'BLOCKER: %s\n' "$1"; FAILURES=$((FAILURES+1)); }
info(){ printf '%s\n' "$1"; }
section(){ printf '\n===== %s =====\n' "$1"; }

if [[ "$EUID" -ne 0 ]]; then
  echo "Run this read-only audit as root. No changes will be made."
  exit 2
fi
for command in systemctl stat node mysql ss free df awk grep; do
  command -v "$command" >/dev/null 2>&1 || { echo "Required command missing: $command"; exit 2; }
done

read_dotenv_value(){
  node --input-type=module - "$1" "$2" <<'NODE'
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
const values=dotenv.parse(readFileSync(process.argv[2]));
process.stdout.write(String(values[process.argv[3]] ?? ''));
NODE
}

section "HOST AND SERVICE"
printf 'timestamp_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'hostname=%s\n' "$(hostname)"
printf 'node=%s\n' "$(node --version)"
free -h | awk '/^Mem:/ {print "memory_total=" $2 " memory_available=" $7}'
df -h / | awk 'NR==2 {print "disk_available=" $4 " disk_total=" $2}'
SERVICE=ustore-telegram-bot.service
systemctl show "$SERVICE" -p LoadState -p ActiveState -p SubState -p User -p MainPID -p WorkingDirectory -p ExecStart --no-pager || fail "Could not inspect service."
ACTIVE="$(systemctl show "$SERVICE" -p WorkingDirectory --value 2>/dev/null || true)"
PID="$(systemctl show "$SERVICE" -p MainPID --value 2>/dev/null || true)"
if [[ -n "$ACTIVE" && -d "$ACTIVE" ]]; then
  printf 'active_release_path=%s\n' "$ACTIVE"
  if [[ -f "$ACTIVE/.env" ]]; then
    stat -c 'runtime_env owner=%U group=%G mode=%a type=%F' "$ACTIVE/.env"
    [[ ! -L "$ACTIVE/.env" ]] || fail "Runtime .env is a symlink."
    [[ "$(stat -c '%a' "$ACTIVE/.env")" == "600" ]] || fail "Runtime .env mode is not 600."
  else
    fail "Runtime .env is missing."
  fi
else
  fail "Service WorkingDirectory is missing."
fi
if [[ "$PID" =~ ^[1-9][0-9]*$ && -e "/proc/$PID/cwd" ]]; then
  printf 'main_process_cwd=%s\n' "$(readlink -f "/proc/$PID/cwd")"
else
  fail "Service has no live MainPID."
fi

section "DATABASE PRIVILEGE SUMMARY"
if [[ -n "$ACTIVE" && -f "$ACTIVE/.env" ]]; then
  DB="$(read_dotenv_value "$ACTIVE/.env" MYSQL_DATABASE)"
  APP_USER="$(read_dotenv_value "$ACTIVE/.env" MYSQL_USER)"
  DB_HOST="$(read_dotenv_value "$ACTIVE/.env" MYSQL_HOST)"
  if [[ "$DB" =~ ^[A-Za-z0-9_]{1,64}$ && "$APP_USER" =~ ^[A-Za-z0-9_]{1,32}$ && "$DB_HOST" == "127.0.0.1" ]]; then
    mysql_q(){ mysql --protocol=socket --batch --skip-column-names -e "$1"; }
    if mysql_q "SELECT VERSION()" >/dev/null 2>&1; then
      printf 'mysql_version=%s\n' "$(mysql_q 'SELECT VERSION()')"
      R1="$(mysql_q "SELECT COUNT(*) FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$APP_USER'),'@',QUOTE('127.0.0.1')) AND TABLE_SCHEMA='$DB'")"
      R2="$(mysql_q "SELECT COUNT(*) FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$APP_USER'),'@',QUOTE('127.0.0.1')) AND TABLE_SCHEMA='$DB' AND PRIVILEGE_TYPE IN ('SELECT','INSERT','UPDATE','DELETE')")"
      R3="$(mysql_q "SELECT COUNT(*) FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$APP_USER'),'@',QUOTE('127.0.0.1')) AND TABLE_SCHEMA='$DB' AND PRIVILEGE_TYPE NOT IN ('SELECT','INSERT','UPDATE','DELETE')")"
      R4="$(mysql_q "SELECT COUNT(*) FROM information_schema.USER_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$APP_USER'),'@',QUOTE('127.0.0.1')) AND PRIVILEGE_TYPE<>'USAGE'")"
      R5="$(mysql_q "SELECT COUNT(*) FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$APP_USER'),'@',QUOTE('127.0.0.1')) AND TABLE_SCHEMA<>'$DB'")"
      R6="$(mysql_q "SELECT COUNT(*) FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$APP_USER'),'@',QUOTE('127.0.0.1'))")"
      printf 'runtime_schema_privilege_rows=%s expected=4\nruntime_allowed_dml_rows=%s expected=4\nruntime_unexpected_schema_privileges=%s expected=0\nruntime_global_privileges=%s expected=0\nruntime_other_schema_grants=%s expected=0\nruntime_table_grants=%s expected=0\n' "$R1" "$R2" "$R3" "$R4" "$R5" "$R6"
      if [[ "$R1" != 4 || "$R2" != 4 || "$R3" != 0 || "$R4" != 0 || "$R5" != 0 || "$R6" != 0 ]]; then
        fail "Runtime account is not proven DML-only on one schema."
      fi
      printf 'runtime_show_grants:\n'
      mysql_q "SHOW GRANTS FOR '$APP_USER'@'127.0.0.1'" || fail "Could not resolve runtime SHOW GRANTS."
    else
      fail "Root MySQL socket inspection failed."
    fi
  else
    fail "Runtime DB identifiers are invalid or MYSQL_HOST is not 127.0.0.1; grant host requires manual verification."
  fi

  MIGRATION_DIR=/etc/ustore-telegram-bot
  MIGRATION_ENV=$MIGRATION_DIR/ustore-telegram-bot-migration.env
  if [[ -d "$MIGRATION_DIR" && -f "$MIGRATION_ENV" ]]; then
    stat -c 'migration_env_directory owner=%U group=%G mode=%a' "$MIGRATION_DIR"
    stat -c 'migration_env_file owner=%U group=%G mode=%a' "$MIGRATION_ENV"
    [[ ! -L "$MIGRATION_DIR" && ! -L "$MIGRATION_ENV" ]] || fail "Migration credential path contains a symlink."
    [[ "$(stat -c '%U:%G:%a' "$MIGRATION_DIR")" == root:root:700 ]] || fail "Migration directory must be root:root mode 700."
    [[ "$(stat -c '%U:%G:%a' "$MIGRATION_ENV")" == root:root:600 ]] || fail "Migration env must be root:root mode 600."
    MIG_USER="$(read_dotenv_value "$MIGRATION_ENV" MYSQL_MIGRATION_USER)"
    MIG_PASS="$(read_dotenv_value "$MIGRATION_ENV" MYSQL_MIGRATION_PASSWORD)"
    MIG_DB="$(read_dotenv_value "$MIGRATION_ENV" MIGRATION_TARGET_DATABASE)"
    if [[ "$MIG_USER" =~ ^[A-Za-z0-9_]{1,32}$ && -n "$MIG_PASS" && "$MIG_USER" != "$APP_USER" && "$MIG_DB" == "$DB" ]]; then
      M1="$(mysql_q "SELECT COUNT(*) FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$MIG_USER'),'@',QUOTE('127.0.0.1')) AND TABLE_SCHEMA='$DB'")"
      M2="$(mysql_q "SELECT COUNT(DISTINCT PRIVILEGE_TYPE) FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$MIG_USER'),'@',QUOTE('127.0.0.1')) AND TABLE_SCHEMA='$DB' AND PRIVILEGE_TYPE IN ('SELECT','INSERT','UPDATE','DELETE','CREATE','ALTER','INDEX','REFERENCES','TRIGGER')")"
      M3="$(mysql_q "SELECT COUNT(*) FROM information_schema.USER_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$MIG_USER'),'@',QUOTE('127.0.0.1')) AND PRIVILEGE_TYPE<>'USAGE'")"
      M4="$(mysql_q "SELECT COUNT(*) FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$MIG_USER'),'@',QUOTE('127.0.0.1')) AND TABLE_SCHEMA<>'$DB'")"
      M5="$(mysql_q "SELECT COUNT(*) FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$MIG_USER'),'@',QUOTE('127.0.0.1'))")"
      printf 'migration_schema_privilege_rows=%s expected=9\nmigration_required_privilege_types=%s expected=9\nmigration_global_privileges=%s expected=0\nmigration_other_schema_grants=%s expected=0\nmigration_table_grants=%s expected=0\n' "$M1" "$M2" "$M3" "$M4" "$M5"
      if [[ "$M1" != 9 || "$M2" != 9 || "$M3" != 0 || "$M4" != 0 || "$M5" != 0 ]]; then
        fail "Migration account does not match schema-scoped least privilege."
      fi
    else
      fail "Migration credentials are missing, not distinct, or bound to another database."
    fi
    unset MIG_PASS
  else
    info "migration_credentials=NOT_CONFIGURED"
    fail "Protected migration-only credentials are missing."
  fi
else
  fail "Could not read active release metadata."
fi

section "RUNNER AND PRIVILEGED HELPER"
RUNNERS="$(systemctl list-units --all --type=service --no-legend 2>/dev/null | awk '$1 ~ /^actions\.runner\./ {print $1 " " $3 " " $4}')"
if [[ -n "$RUNNERS" ]]; then
  printf 'runner_units:\n%s\n' "$RUNNERS"
  fail "A self-hosted GitHub Runner service remains on this host."
else
  info "runner_units=none_detected"
fi
if id ghrunner >/dev/null 2>&1; then
  id ghrunner
  sudo -l -U ghrunner 2>&1 || true
  if sudo -l -U ghrunner 2>&1 | grep -q NOPASSWD; then fail "ghrunner has passwordless sudo."; fi
else
  info "ghrunner_account=not_present"
fi
if [[ -e /usr/local/sbin/istore-admin ]]; then
  stat -c 'privileged_helper owner=%U group=%G mode=%a' /usr/local/sbin/istore-admin
  sha256sum /usr/local/sbin/istore-admin
fi
if [[ -f /etc/sudoers.d/istore-admin ]]; then
  grep -nE '^[[:space:]]*[^#].*istore-admin' /etc/sudoers.d/istore-admin || true
  fail "istore-admin sudoers rule still exists."
fi

section "BACKUP SCHEDULING"
BACKUP_TIMERS="$(systemctl list-timers --all --no-pager 2>/dev/null | grep -Ei 'mysql|mariadb|database|ustore.*backup|backup.*ustore' || true)"
if [[ -n "$BACKUP_TIMERS" ]]; then printf '%s\n' "$BACKUP_TIMERS"; else info "application_database_backup_timer=not_detected"; fail "No application DB backup timer detected; confirm external scheduling."; fi
for directory in /root/ustore-backups /opt/ustore-backups; do
  if [[ -d "$directory" ]]; then
    find "$directory" -maxdepth 2 -type f \( -name '*.sql.gz' -o -name '*.sql.zst' -o -name '*.sql.xz' \) -printf '%TY-%Tm-%TdT%TH:%TM %u:%g %m %s bytes %p\n' | sort
  fi
done

section "NETWORK AND FIREWALL"
if command -v ufw >/dev/null 2>&1; then ufw status verbose || true; else info "ufw=not_installed"; fi
printf 'listening_tcp_ports:\n'
ss -lntp 2>/dev/null | awk 'NR==1 || /LISTEN/'
info "Provider-level firewall status must be checked separately in the hosting control panel."

section "RESULT"
if [[ "$FAILURES" -eq 0 ]]; then
  info "HOST_CHECKS=PASS (does not replace staging, restore, privacy/legal, or load-test approval)"
else
  printf 'HOST_CHECKS=BLOCKED failures=%s\n' "$FAILURES"
  exit 1
fi
