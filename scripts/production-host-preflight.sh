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
for command in systemctl stat node mysql ss free df awk grep find wc sort date hostname readlink id sudo crontab curl; do
  command -v "$command" >/dev/null 2>&1 || { echo "Required command missing: $command"; exit 2; }
done

read_dotenv_value(){
  node --input-type=module - "$1" "$2" "$3" <<'NODE'
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
const release=process.argv[2];
const file=process.argv[3];
const key=process.argv[4];
// Resolve dotenv from the active release, not from the protected /etc
// migration-env directory (which intentionally has no node_modules).
const require=createRequire(join(release,'package.json'));
const dotenv=require('dotenv');
const values=dotenv.parse(readFileSync(file));
process.stdout.write(String(values[key] ?? ''));
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
  if [[ -f "$ACTIVE/.env" && ! -L "$ACTIVE/.env" ]]; then
    NOTICE_URL="$(read_dotenv_value "$ACTIVE" "$ACTIVE/.env" PRIVACY_NOTICE_URL)"
    NOTICE_VERSION="$(read_dotenv_value "$ACTIVE" "$ACTIVE/.env" PRIVACY_NOTICE_VERSION)"
    if [[ "$NOTICE_URL" =~ ^https://[^[:space:]]{1,2040}$ && "$NOTICE_VERSION" =~ ^[A-Za-z0-9._-]{1,40}$ ]]; then
      NOTICE_HOST="$(node --input-type=module -e 'process.stdout.write(new URL(process.argv[1]).hostname)' "$NOTICE_URL")"
      if [[ "$NOTICE_HOST" == "example.com" || "$NOTICE_HOST" == "www.example.com" || "$NOTICE_HOST" == "localhost" || "$NOTICE_HOST" == *.example || "$NOTICE_HOST" == *.test || "$NOTICE_HOST" == *.invalid ]]; then
        fail "PRIVACY_NOTICE_URL still points to a placeholder or local host."
      elif curl --fail --silent --show-error --location --max-time 10 --proto '=https' --proto-redir '=https' --output /dev/null "$NOTICE_URL"; then
        info "privacy_notice=reachable_https_with_version"
      else
        fail "Configured HTTPS privacy notice URL is not reachable."
      fi
    else
      fail "Runtime .env must contain a valid HTTPS PRIVACY_NOTICE_URL and PRIVACY_NOTICE_VERSION."
    fi
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
  DB="$(read_dotenv_value "$ACTIVE" "$ACTIVE/.env" MYSQL_DATABASE)"
  APP_USER="$(read_dotenv_value "$ACTIVE" "$ACTIVE/.env" MYSQL_USER)"
  APP_PASS="$(read_dotenv_value "$ACTIVE" "$ACTIVE/.env" MYSQL_PASSWORD)"
  DB_HOST="$(read_dotenv_value "$ACTIVE" "$ACTIVE/.env" MYSQL_HOST)"
  MYSQL_READY=0
  mysql_q(){ mysql --protocol=socket --batch --skip-column-names -e "$1"; }
  if [[ "$DB" =~ ^[A-Za-z0-9_]{1,64}$ && "$APP_USER" =~ ^[A-Za-z0-9_]{1,32}$ && -n "$APP_PASS" && "$DB_HOST" == "127.0.0.1" ]]; then
    if mysql_q "SELECT VERSION()" >/dev/null 2>&1; then
      MYSQL_READY=1
      printf 'mysql_version=%s\n' "$(mysql_q 'SELECT VERSION()')"
      R1="$(mysql_q "SELECT COUNT(*) FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$APP_USER'),'@',QUOTE('127.0.0.1')) AND TABLE_SCHEMA='$DB'")"
      R2="$(mysql_q "SELECT COUNT(*) FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$APP_USER'),'@',QUOTE('127.0.0.1')) AND TABLE_SCHEMA='$DB' AND PRIVILEGE_TYPE IN ('SELECT','INSERT','UPDATE','DELETE')")"
      R3="$(mysql_q "SELECT COUNT(*) FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$APP_USER'),'@',QUOTE('127.0.0.1')) AND TABLE_SCHEMA='$DB' AND PRIVILEGE_TYPE NOT IN ('SELECT','INSERT','UPDATE','DELETE')")"
      R4="$(mysql_q "SELECT COUNT(*) FROM information_schema.USER_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$APP_USER'),'@',QUOTE('127.0.0.1')) AND PRIVILEGE_TYPE<>'USAGE'")"
      R5="$(mysql_q "SELECT COUNT(*) FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$APP_USER'),'@',QUOTE('127.0.0.1')) AND TABLE_SCHEMA<>'$DB'")"
      R6="$(mysql_q "SELECT COUNT(*) FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$APP_USER'),'@',QUOTE('127.0.0.1'))")"
      R7="$(mysql_q "SELECT COUNT(*) FROM mysql.default_roles WHERE USER='$APP_USER' AND HOST='127.0.0.1'" 2>/dev/null || echo UNKNOWN)"
      R8="$(mysql_q "SELECT COUNT(*) FROM mysql.role_edges WHERE TO_USER='$APP_USER' AND TO_HOST='127.0.0.1'" 2>/dev/null || echo UNKNOWN)"
      R9="$(mysql_q "SELECT COUNT(*) FROM mysql.user WHERE User='$APP_USER' AND Host<>'127.0.0.1'" 2>/dev/null || echo UNKNOWN)"
      R10="$(mysql_q "SELECT COUNT(*) FROM mysql.proxies_priv WHERE User='$APP_USER' AND Host='127.0.0.1'" 2>/dev/null || echo UNKNOWN)"
      printf 'runtime_schema_privilege_rows=%s expected=4\nruntime_allowed_dml_rows=%s expected=4\nruntime_unexpected_schema_privileges=%s expected=0\nruntime_global_privileges=%s expected=0\nruntime_other_schema_grants=%s expected=0\nruntime_table_grants=%s expected=0\nruntime_default_roles=%s expected=0\nruntime_granted_roles=%s expected=0\nruntime_alternate_host_accounts=%s expected=0\nruntime_proxy_grants=%s expected=0\n' "$R1" "$R2" "$R3" "$R4" "$R5" "$R6" "$R7" "$R8" "$R9" "$R10"
      if [[ "$R1" != 4 || "$R2" != 4 || "$R3" != 0 || "$R4" != 0 || "$R5" != 0 || "$R6" != 0 || "$R7" != 0 || "$R8" != 0 || "$R9" != 0 || "$R10" != 0 ]]; then
        fail "Runtime account is not proven DML-only on exactly one host identity and one schema."
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
    MIG_USER="$(read_dotenv_value "$ACTIVE" "$MIGRATION_ENV" MYSQL_MIGRATION_USER)"
    MIG_PASS="$(read_dotenv_value "$ACTIVE" "$MIGRATION_ENV" MYSQL_MIGRATION_PASSWORD)"
    MIG_DB="$(read_dotenv_value "$ACTIVE" "$MIGRATION_ENV" MIGRATION_TARGET_DATABASE)"
    if [[ "$MYSQL_READY" == 1 && "$MIG_USER" =~ ^[A-Za-z0-9_]{1,32}$ && -n "$MIG_PASS" && "$MIG_USER" != "$APP_USER" && "$MIG_PASS" != "$APP_PASS" && "$MIG_DB" == "$DB" ]]; then
      M1="$(mysql_q "SELECT COUNT(*) FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$MIG_USER'),'@',QUOTE('127.0.0.1')) AND TABLE_SCHEMA='$DB'")"
      M2="$(mysql_q "SELECT COUNT(DISTINCT PRIVILEGE_TYPE) FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$MIG_USER'),'@',QUOTE('127.0.0.1')) AND TABLE_SCHEMA='$DB' AND PRIVILEGE_TYPE IN ('SELECT','INSERT','UPDATE','DELETE','CREATE','ALTER','INDEX','REFERENCES','TRIGGER')")"
      M3="$(mysql_q "SELECT COUNT(*) FROM information_schema.USER_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$MIG_USER'),'@',QUOTE('127.0.0.1')) AND PRIVILEGE_TYPE<>'USAGE'")"
      M4="$(mysql_q "SELECT COUNT(*) FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$MIG_USER'),'@',QUOTE('127.0.0.1')) AND TABLE_SCHEMA<>'$DB'")"
      M5="$(mysql_q "SELECT COUNT(*) FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$MIG_USER'),'@',QUOTE('127.0.0.1'))")"
      M6="$(mysql_q "SELECT COUNT(*) FROM mysql.default_roles WHERE USER='$MIG_USER' AND HOST='127.0.0.1'" 2>/dev/null || echo UNKNOWN)"
      M7="$(mysql_q "SELECT COUNT(*) FROM mysql.role_edges WHERE TO_USER='$MIG_USER' AND TO_HOST='127.0.0.1'" 2>/dev/null || echo UNKNOWN)"
      M8="$(mysql_q "SELECT COUNT(*) FROM mysql.user WHERE User='$MIG_USER' AND Host<>'127.0.0.1'" 2>/dev/null || echo UNKNOWN)"
      M9="$(mysql_q "SELECT COUNT(*) FROM mysql.proxies_priv WHERE User='$MIG_USER' AND Host='127.0.0.1'" 2>/dev/null || echo UNKNOWN)"
      printf 'migration_schema_privilege_rows=%s expected=9\nmigration_required_privilege_types=%s expected=9\nmigration_global_privileges=%s expected=0\nmigration_other_schema_grants=%s expected=0\nmigration_table_grants=%s expected=0\nmigration_default_roles=%s expected=0\nmigration_granted_roles=%s expected=0\nmigration_alternate_host_accounts=%s expected=0\nmigration_proxy_grants=%s expected=0\n' "$M1" "$M2" "$M3" "$M4" "$M5" "$M6" "$M7" "$M8" "$M9"
      if [[ "$M1" != 9 || "$M2" != 9 || "$M3" != 0 || "$M4" != 0 || "$M5" != 0 || "$M6" != 0 || "$M7" != 0 || "$M8" != 0 || "$M9" != 0 ]]; then
        fail "Migration account does not match schema-scoped least privilege on exactly one host identity."
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
RUNNER_UNIT_FILES="$(systemctl list-unit-files --type=service --no-legend 'actions.runner.*' 2>/dev/null | awk 'NF {print $1 " " $2}')"
if [[ -n "$RUNNER_UNIT_FILES" ]]; then
  printf 'runner_unit_files:\n%s\n' "$RUNNER_UNIT_FILES"
  fail "A self-hosted GitHub Runner unit file remains installed on this host."
else
  info "runner_unit_files=none_detected"
fi
RUNNER_CONFIGS="$(find /home /opt /root -maxdepth 5 -type f \( -name .runner -o -name .credentials -o -name .credentials_rsaparams \) -print 2>/dev/null || true)"
if [[ -n "$RUNNER_CONFIGS" ]]; then
  printf 'runner_registration_metadata_paths:\n%s\n' "$RUNNER_CONFIGS"
  fail "Self-hosted GitHub Runner registration metadata remains on this host."
else
  info "runner_registration_metadata=none_detected"
fi
if id ghrunner >/dev/null 2>&1; then
  id ghrunner
  if GHrunner_SUDO_POLICY="$(sudo -l -U ghrunner 2>&1)"; then
    printf '%s\n' "$GHrunner_SUDO_POLICY"
    if grep -Eq '^[[:space:]]*\([^)]*\)[[:space:]]' <<<"$GHrunner_SUDO_POLICY"; then
      fail "ghrunner has sudo command grants; the self-hosted runner account must have no sudo access."
    else
      info "ghrunner_sudo=none_detected"
    fi
  else
    printf '%s\n' "$GHrunner_SUDO_POLICY"
    fail "Could not reliably inspect ghrunner sudo policy."
  fi
else
  info "ghrunner_account=not_present"
fi
if [[ -e /usr/local/sbin/istore-admin ]]; then
  stat -c 'privileged_helper owner=%U group=%G mode=%a' /usr/local/sbin/istore-admin
  sha256sum /usr/local/sbin/istore-admin
  [[ "$(stat -c '%U:%G' /usr/local/sbin/istore-admin)" == "root:root" ]] || fail "Privileged helper must be owned by root:root."
  if find /usr/local/sbin/istore-admin -maxdepth 0 -perm /6022 -print -quit | grep -q .; then
    fail "Privileged helper has setuid/setgid or group/world write permissions."
  fi
fi
if [[ -f /etc/sudoers.d/istore-admin ]]; then
  grep -nE '^[[:space:]]*[^#].*istore-admin' /etc/sudoers.d/istore-admin || true
  fail "istore-admin sudoers rule still exists."
fi

section "BACKUP SCHEDULING"
BACKUP_TIMERS="$(systemctl list-timers --all --no-pager 2>/dev/null | grep -Ei 'mysql|mariadb|database|ustore.*backup|backup.*ustore' || true)"
if [[ -n "$BACKUP_TIMERS" ]]; then printf 'backup_timers:\n%s\n' "$BACKUP_TIMERS"; else info "application_database_backup_timer=not_detected"; fi
CRON_BACKUP_COUNT="$({ crontab -l -u root 2>/dev/null || true; grep -hE '^[[:space:]]*[^#]' /etc/cron.d/* /etc/cron.daily/* /etc/cron.hourly/* /etc/cron.weekly/* 2>/dev/null || true; } | grep -Eic 'mysqldump|mysqlpump|mariadb-dump|mysql.*backup|mariadb.*backup|ustore.*backup' || true)"
printf 'database_backup_cron_references=%s (contents are not printed)\n' "$CRON_BACKUP_COUNT"
if [[ -z "$BACKUP_TIMERS" && "$CRON_BACKUP_COUNT" -eq 0 ]]; then fail "No application DB backup timer or matching cron reference was detected; confirm external scheduling."; fi
for directory in /root/ustore-backups /opt/ustore-backups; do
  if [[ -d "$directory" ]]; then
    find "$directory" -maxdepth 2 -type f \( -name '*.sql.gz' -o -name '*.sql.zst' -o -name '*.sql.xz' \) -printf '%TY-%Tm-%TdT%TH:%TM %u:%g %m %s bytes %p\n' | sort
  fi
done

section "DRAW KEY AND DATABASE BACKUP PROTECTION"
KEY_BACKUP_DIR=/root/ustore-key-backup
if [[ -d "$KEY_BACKUP_DIR" ]]; then
  stat -c 'draw_key_backup_directory owner=%U group=%G mode=%a' "$KEY_BACKUP_DIR"
  [[ "$(stat -c '%U:%G:%a' "$KEY_BACKUP_DIR")" == root:root:700 ]] || fail "Draw-key backup directory must be root:root mode 700."
  find "$KEY_BACKUP_DIR" -maxdepth 1 -type f -printf '%TY-%Tm-%TdT%TH:%TM %u:%g %m %s bytes %f\n' | sort
  PLAINTEXT_KEY_FILES="$(find "$KEY_BACKUP_DIR" -maxdepth 1 -type f \( -iname '*draw*key*.txt' -o -iname 'DRAW_SEED_ENCRYPTION_KEY.txt' \) -print)"
  if [[ -n "$PLAINTEXT_KEY_FILES" ]]; then
    fail "A plaintext draw-key backup file exists; keep only protected encrypted key backups and rehearse restoration."
  fi
  ENCRYPTED_KEY_FILES="$(find "$KEY_BACKUP_DIR" -maxdepth 1 -type f \( -name '*.gpg' -o -name '*.age' -o -name '*.enc' \) -print)"
  if [[ -z "$ENCRYPTED_KEY_FILES" ]]; then
    fail "No encrypted draw-key backup artifact was detected."
  fi
else
  fail "Protected draw-key backup directory is missing."
fi
ENCRYPTED_DB_BACKUPS=0
for directory in /root/ustore-backups /opt/ustore-backups /root/ustore-release-backup-*; do
  [[ -d "$directory" ]] || continue
  count="$(find "$directory" -maxdepth 2 -type f \( -name '*.sql.gz.gpg' -o -name '*.sql.gz.age' -o -name '*.sql.gz.enc' -o -name '*.sql.zst.gpg' -o -name '*.sql.zst.age' -o -name '*.sql.zst.enc' \) -printf '.' | wc -c)"
  ENCRYPTED_DB_BACKUPS=$((ENCRYPTED_DB_BACKUPS+count))
done
printf 'encrypted_database_backup_artifacts=%s (inspected local paths; off-host evidence must be checked separately)\n' "$ENCRYPTED_DB_BACKUPS"
if [[ "$ENCRYPTED_DB_BACKUPS" -eq 0 ]]; then fail "No encrypted database backup artifact was detected in the inspected local paths."; fi


PLAINTEXT_DB_BACKUPS=0
for directory in /root/ustore-backups /opt/ustore-backups /root/ustore-release-backup-*; do
  [[ -d "$directory" ]] || continue
  count="$(find "$directory" -maxdepth 2 -type f \( -name '*.sql' -o -name '*.sql.gz' -o -name '*.sql.zst' -o -name '*.sql.xz' -o -name '*.sql.bz2' -o -name '*.dump' -o -name '*.dump.gz' \) -printf '.' | wc -c)"
  PLAINTEXT_DB_BACKUPS=$((PLAINTEXT_DB_BACKUPS+count))
done
printf 'plaintext_database_backup_artifacts=%s expected=0\n' "$PLAINTEXT_DB_BACKUPS"
if [[ "$PLAINTEXT_DB_BACKUPS" -gt 0 ]]; then fail "Unencrypted database backup artifacts were detected; compression alone is not encryption."; fi

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
