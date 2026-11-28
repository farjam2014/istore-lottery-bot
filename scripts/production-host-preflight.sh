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
for command in systemctl stat node mysql ss free df awk grep find wc sort date hostname readlink id sudo crontab curl pgrep tr sed journalctl; do
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

verify_mysql_identity(){
  node --input-type=module - "$1" "$2" "$3" "$4" "$5" "$6" "$7" <<'NODE'
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
const [release,runtimeFile,credentialFile,userKey,passwordKey,databaseKey,label]=process.argv.slice(2);
const require=createRequire(join(release,'package.json'));
const dotenv=require('dotenv');
const mysql=require('mysql2/promise');
const runtime=dotenv.parse(readFileSync(runtimeFile));
const credentials=dotenv.parse(readFileSync(credentialFile));
const host=runtime.MYSQL_HOST;
const port=Number(runtime.MYSQL_PORT||3306);
const user=credentials[userKey];
const password=credentials[passwordKey];
const database=credentials[databaseKey]||runtime.MYSQL_DATABASE;
let connection;
try{
  if(!host||!user||!password||!database)throw new Error('missing credentials');
  connection=await mysql.createConnection({host,port,user,password,database,connectTimeout:5000});
  const [[identity]]=await connection.query('SELECT CURRENT_USER() AS account, DATABASE() AS schema_name');
  if(identity.account!==user+'@'+host||identity.schema_name!==database)throw new Error('unexpected MySQL identity');
  process.stdout.write(label+'_authentication=verified\n');
}catch{
  process.stderr.write(label+'_authentication=failed (credentials, TCP access, or effective MySQL identity mismatch)\n');
  process.exitCode=1;
}finally{
  if(connection)await connection.end().catch(()=>{});
}
NODE
}

section "HOST AND SERVICE"
printf 'timestamp_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'hostname=%s\n' "$(hostname)"
printf 'node=%s\n' "$(node --version)"
free -h | awk '/^Mem:/ {print "memory_total=" $2 " memory_available=" $7}'
df -h / | awk 'NR==2 {print "disk_available=" $4 " disk_total=" $2}'
SERVICE=ustore-telegram-bot.service
systemctl show "$SERVICE" -p LoadState -p ActiveState -p SubState -p User -p Group -p MainPID -p WorkingDirectory -p ExecStart -p NoNewPrivileges -p PrivateTmp -p ProtectSystem -p ProtectHome -p ReadWritePaths --no-pager || fail "Could not inspect service."
SERVICE_USER="$(systemctl show "$SERVICE" -p User --value 2>/dev/null || true)"
SERVICE_GROUP="$(systemctl show "$SERVICE" -p Group --value 2>/dev/null || true)"
NO_NEW_PRIVILEGES="$(systemctl show "$SERVICE" -p NoNewPrivileges --value 2>/dev/null || true)"
PRIVATE_TMP="$(systemctl show "$SERVICE" -p PrivateTmp --value 2>/dev/null || true)"
PROTECT_SYSTEM="$(systemctl show "$SERVICE" -p ProtectSystem --value 2>/dev/null || true)"
PROTECT_HOME="$(systemctl show "$SERVICE" -p ProtectHome --value 2>/dev/null || true)"
READ_WRITE_PATHS="$(systemctl show "$SERVICE" -p ReadWritePaths --value 2>/dev/null || true)"
EXEC_START="$(systemctl show "$SERVICE" -p ExecStart --value 2>/dev/null || true)"
ACTIVE="$(systemctl show "$SERVICE" -p WorkingDirectory --value 2>/dev/null || true)"
PID="$(systemctl show "$SERVICE" -p MainPID --value 2>/dev/null || true)"
[[ "$SERVICE_USER" == "ustorebot" ]] || fail "Service must run as the dedicated ustorebot account, not root or another identity."
[[ "$SERVICE_GROUP" == "ustorebot" ]] || fail "Service group must be ustorebot."
[[ "$NO_NEW_PRIVILEGES" == "yes" ]] || fail "systemd NoNewPrivileges must be enabled."
[[ "$PRIVATE_TMP" == "yes" ]] || fail "systemd PrivateTmp must be enabled."
[[ "$PROTECT_SYSTEM" == "strict" ]] || fail "systemd ProtectSystem must be strict."
[[ "$PROTECT_HOME" == "yes" ]] || fail "systemd ProtectHome must be enabled."
if [[ -n "$ACTIVE" ]]; then
  [[ -z "$READ_WRITE_PATHS" ]] && info "systemd_read_write_paths=none" || fail "systemd service must not have any writable filesystem exceptions; use PrivateTmp for ephemeral files."
  [[ "$EXEC_START" == *"$ACTIVE/src/index.js"* ]] || fail "systemd ExecStart must target the active release entry point."
fi
if [[ -n "$ACTIVE" && -d "$ACTIVE" ]]; then
  printf 'active_release_path=%s\n' "$ACTIVE"
  if [[ -f "$ACTIVE/.env" ]]; then
    stat -c 'runtime_env owner=%U group=%G mode=%a type=%F' "$ACTIVE/.env"
    [[ ! -L "$ACTIVE/.env" ]] || fail "Runtime .env is a symlink."
    [[ "$(stat -c '%U:%G:%a' "$ACTIVE/.env")" == "ustorebot:ustorebot:600" ]] || fail "Runtime .env must be owned by ustorebot:ustorebot with mode 600."
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
  PROCESS_CWD="$(readlink -f "/proc/$PID/cwd")"
  ACTIVE_REAL="$(readlink -f "$ACTIVE")"
  PROCESS_OWNER="$(stat -c '%U' "/proc/$PID")"
  printf 'main_process_cwd=%s\nmain_process_owner=%s\n' "$PROCESS_CWD" "$PROCESS_OWNER"
  [[ "$PROCESS_CWD" == "$ACTIVE_REAL" ]] || fail "Live process working directory differs from the active release path."
  [[ "$PROCESS_OWNER" == "ustorebot" ]] || fail "Live process is not running as ustorebot."
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
      BINLOG_ENABLED="$(mysql_q 'SELECT @@GLOBAL.log_bin' 2>/dev/null || echo UNKNOWN)"
      BINLOG_TRUSTED_CREATORS="$(mysql_q 'SELECT @@GLOBAL.log_bin_trust_function_creators' 2>/dev/null || echo UNKNOWN)"
      printf 'mysql_binary_logging=%s log_bin_trust_function_creators=%s\n' "$BINLOG_ENABLED" "$BINLOG_TRUSTED_CREATORS"
      if [[ "$BINLOG_ENABLED" != 0 && "$BINLOG_ENABLED" != 1 ]]; then
        fail "Could not reliably inspect MySQL binary logging and trigger-creator trust settings."
      elif [[ "$BINLOG_ENABLED" == 1 && "$BINLOG_TRUSTED_CREATORS" == 0 ]]; then
        info "mysql_trigger_creator_trust=OFF; the approved migration runbook must enable it temporarily only during trigger migration and restore OFF immediately afterward."
      elif [[ "$BINLOG_ENABLED" == 1 && "$BINLOG_TRUSTED_CREATORS" != 1 ]]; then
        fail "Could not reliably inspect MySQL trigger-creator trust setting."
      else
        info "mysql_trigger_creator_trust=not_required_or_enabled"
      fi
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
      R11="$(mysql_q "SELECT COUNT(*) FROM information_schema.COLUMN_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$APP_USER'),'@',QUOTE('127.0.0.1'))")"
      R12="$(mysql_q "SELECT COUNT(*) FROM mysql.procs_priv WHERE User='$APP_USER' AND Host='127.0.0.1'")"
      R13="$(mysql_q "SELECT COUNT(*) FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$APP_USER'),'@',QUOTE('127.0.0.1')) AND TABLE_SCHEMA='$DB' AND IS_GRANTABLE='YES'")"
      printf 'runtime_schema_privilege_rows=%s expected=4\nruntime_allowed_dml_rows=%s expected=4\nruntime_unexpected_schema_privileges=%s expected=0\nruntime_global_privileges=%s expected=0\nruntime_other_schema_grants=%s expected=0\nruntime_table_grants=%s expected=0\nruntime_default_roles=%s expected=0\nruntime_granted_roles=%s expected=0\nruntime_alternate_host_accounts=%s expected=0\nruntime_proxy_grants=%s expected=0\nruntime_column_grants=%s expected=0\nruntime_routine_object_grants=%s expected=0\nruntime_grant_option_rows=%s expected=0\n' "$R1" "$R2" "$R3" "$R4" "$R5" "$R6" "$R7" "$R8" "$R9" "$R10" "$R11" "$R12" "$R13"
      if [[ "$R1" != 4 || "$R2" != 4 || "$R3" != 0 || "$R4" != 0 || "$R5" != 0 || "$R6" != 0 || "$R7" != 0 || "$R8" != 0 || "$R9" != 0 || "$R10" != 0 || "$R11" != 0 || "$R12" != 0 || "$R13" != 0 ]]; then
        fail "Runtime account is not proven DML-only on exactly one host identity and one schema."
      fi
      printf 'runtime_show_grants:\n'
      mysql_q "SHOW GRANTS FOR '$APP_USER'@'127.0.0.1'" || fail "Could not resolve runtime SHOW GRANTS."
      verify_mysql_identity "$ACTIVE" "$ACTIVE/.env" "$ACTIVE/.env" MYSQL_USER MYSQL_PASSWORD MYSQL_DATABASE runtime || fail "Runtime DB credentials do not authenticate as the expected runtime identity."
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
      M10="$(mysql_q "SELECT COUNT(*) FROM information_schema.COLUMN_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$MIG_USER'),'@',QUOTE('127.0.0.1'))")"
      M11="$(mysql_q "SELECT COUNT(*) FROM mysql.procs_priv WHERE User='$MIG_USER' AND Host='127.0.0.1'")"
      M12="$(mysql_q "SELECT COUNT(*) FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$MIG_USER'),'@',QUOTE('127.0.0.1')) AND TABLE_SCHEMA='$DB' AND IS_GRANTABLE='YES'")"
      printf 'migration_schema_privilege_rows=%s expected=9\nmigration_required_privilege_types=%s expected=9\nmigration_global_privileges=%s expected=0\nmigration_other_schema_grants=%s expected=0\nmigration_table_grants=%s expected=0\nmigration_default_roles=%s expected=0\nmigration_granted_roles=%s expected=0\nmigration_alternate_host_accounts=%s expected=0\nmigration_proxy_grants=%s expected=0\nmigration_column_grants=%s expected=0\nmigration_routine_object_grants=%s expected=0\nmigration_grant_option_rows=%s expected=0\n' "$M1" "$M2" "$M3" "$M4" "$M5" "$M6" "$M7" "$M8" "$M9" "$M10" "$M11" "$M12"
      if [[ "$M1" != 9 || "$M2" != 9 || "$M3" != 0 || "$M4" != 0 || "$M5" != 0 || "$M6" != 0 || "$M7" != 0 || "$M8" != 0 || "$M9" != 0 || "$M10" != 0 || "$M11" != 0 || "$M12" != 0 ]]; then
        fail "Migration account does not match schema-scoped least privilege on exactly one host identity."
      fi
      verify_mysql_identity "$ACTIVE" "$ACTIVE/.env" "$MIGRATION_ENV" MYSQL_MIGRATION_USER MYSQL_MIGRATION_PASSWORD MIGRATION_TARGET_DATABASE migration || fail "Migration DB credentials do not authenticate as the expected migration identity."
    else
      fail "Migration credentials are missing, not distinct, or bound to another database."
    fi
    unset MIG_PASS
  else
    info "migration_credentials=NOT_CONFIGURED"
    fail "Protected migration-only credentials are missing."
  fi
  unset APP_PASS
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
RUNNER_UNIT_FILES="$( { systemctl list-unit-files --type=service --no-legend 'actions.runner.*' 2>/dev/null || true; } | awk 'NF {print $1 " " $2}')"
if [[ -n "$RUNNER_UNIT_FILES" ]]; then
  printf 'runner_unit_files:\n%s\n' "$RUNNER_UNIT_FILES"
  fail "A self-hosted GitHub Runner unit file remains installed on this host."
else
  info "runner_unit_files=none_detected"
fi
RUNNER_CONFIGS="$(find /home /opt /root /srv /var/lib /usr/local -maxdepth 6 -type f \( -name .runner -o -name .credentials -o -name .credentials_rsaparams \) -print 2>/dev/null || true)"
if [[ -n "$RUNNER_CONFIGS" ]]; then
  printf 'runner_registration_metadata_paths:\n%s\n' "$RUNNER_CONFIGS"
  fail "Self-hosted GitHub Runner registration metadata remains on this host."
else
  info "runner_registration_metadata=none_detected"
fi
RUNNER_PROCESSES="$( { pgrep -f '[R]unner.Listener' || true; pgrep -f '[R]unner.Worker' || true; } | sort -u )"
if [[ -n "$RUNNER_PROCESSES" ]]; then
  printf 'runner_process_ids=%s\n' "$(tr '\n' ' ' <<<"$RUNNER_PROCESSES" | sed 's/[[:space:]]*$//')"
  fail "A self-hosted GitHub Runner process is active outside the systemd unit inventory."
else
  info "runner_processes=none_detected"
fi
if id ghrunner >/dev/null 2>&1; then
  id ghrunner
  GHrunner_SUDO_STATUS=0
  GHrunner_SUDO_POLICY="$(sudo -l -U ghrunner 2>&1)" || GHrunner_SUDO_STATUS=$?
  printf '%s\n' "$GHrunner_SUDO_POLICY"
  if [[ "$GHrunner_SUDO_STATUS" -eq 0 ]]; then
    if grep -Eq '^[[:space:]]*\([^)]*\)[[:space:]]' <<<"$GHrunner_SUDO_POLICY"; then
      fail "ghrunner has sudo command grants; the self-hosted runner account must have no sudo access."
    else
      info "ghrunner_sudo=none_detected"
    fi
  elif grep -Eqi 'not allowed to run sudo|may not run sudo|not in the sudoers file' <<<"$GHrunner_SUDO_POLICY"; then
    info "ghrunner_sudo=none_detected"
  else
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
BACKUP_TIMER=ustore-production-backup.timer
BACKUP_SERVICE=ustore-production-backup.service
BACKUP_TIMER_STATE="$(systemctl is-active "$BACKUP_TIMER" 2>/dev/null || true)"
BACKUP_TIMER_ENABLED="$(systemctl is-enabled "$BACKUP_TIMER" 2>/dev/null || true)"
BACKUP_SERVICE_RESULT="$(systemctl show "$BACKUP_SERVICE" -p Result --value 2>/dev/null || true)"
BACKUP_SERVICE_EXIT="$(systemctl show "$BACKUP_SERVICE" -p ExecMainStatus --value 2>/dev/null || true)"
BACKUP_SERVICE_USER="$(systemctl show "$BACKUP_SERVICE" -p User --value 2>/dev/null || true)"
BACKUP_SERVICE_EXEC="$(systemctl show "$BACKUP_SERVICE" -p ExecStart --value 2>/dev/null || true)"
BACKUP_FRAGMENT_PATH="$(systemctl show "$BACKUP_SERVICE" -p FragmentPath --value 2>/dev/null || true)"
BACKUP_DROP_IN_PATHS="$(systemctl show "$BACKUP_SERVICE" -p DropInPaths --value 2>/dev/null || true)"
BACKUP_PROTECT_SYSTEM="$(systemctl show "$BACKUP_SERVICE" -p ProtectSystem --value 2>/dev/null || true)"
BACKUP_PROTECT_HOME="$(systemctl show "$BACKUP_SERVICE" -p ProtectHome --value 2>/dev/null || true)"
BACKUP_NO_NEW_PRIVILEGES="$(systemctl show "$BACKUP_SERVICE" -p NoNewPrivileges --value 2>/dev/null || true)"
BACKUP_PRIVATE_TMP="$(systemctl show "$BACKUP_SERVICE" -p PrivateTmp --value 2>/dev/null || true)"
BACKUP_READ_WRITE_PATHS="$(systemctl show "$BACKUP_SERVICE" -p ReadWritePaths --value 2>/dev/null || true)"

BACKUP_UNIT_CREDENTIAL_DIRECTIVE=""
if [[ -n "$BACKUP_FRAGMENT_PATH" && -f "$BACKUP_FRAGMENT_PATH" && ! -L "$BACKUP_FRAGMENT_PATH" ]]; then
  BACKUP_UNIT_CREDENTIAL_DIRECTIVE="$(
    awk '
      /^\[Service\][[:space:]]*$/ { in_service=1; next }
      /^\[/ { in_service=0 }
      in_service && /^[[:space:]]*#/ { next }
      in_service && /^[[:space:]]*LoadCredentialEncrypted[[:space:]]*=/ {
        sub(/^[[:space:]]*/, "")
        sub(/[[:space:]]*$/, "")
        print
      }
    ' "$BACKUP_FRAGMENT_PATH"
  )"
fi

BACKUP_SUCCESS_LINE="$(journalctl -u "$BACKUP_SERVICE" --since '26 hours ago' --no-pager -o cat 2>/dev/null | grep -E '^BACKUP SUCCESS: ' | tail -n 1 || true)"
BACKUP_SUCCESS_TIME="$(printf '%s' "$BACKUP_SUCCESS_LINE" | sed 's/^BACKUP SUCCESS: //')"
LATEST_VERIFIED_BACKUP_RUN_EPOCH=0
if [[ "$BACKUP_SUCCESS_TIME" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2} ]]; then
  LATEST_VERIFIED_BACKUP_RUN_EPOCH="$(date -d "$BACKUP_SUCCESS_TIME" +%s 2>/dev/null || echo 0)"
fi

printf 'backup_timer=%s state=%s enabled=%s service_result=%s exit_status=%s journal_success=%s\n' \
  "$BACKUP_TIMER" "$BACKUP_TIMER_STATE" "$BACKUP_TIMER_ENABLED" "$BACKUP_SERVICE_RESULT" "$BACKUP_SERVICE_EXIT" \
  "$([[ -n "$BACKUP_SUCCESS_LINE" ]] && echo recorded || echo missing)"

[[ "$BACKUP_TIMER_STATE" == active ]] || fail "The dedicated production backup timer is not active."
[[ "$BACKUP_TIMER_ENABLED" == enabled ]] || fail "The dedicated production backup timer is not enabled."
[[ "$BACKUP_SERVICE_RESULT" == success && "$BACKUP_SERVICE_EXIT" == 0 ]] || fail "The latest backup service invocation did not finish successfully."
[[ "$BACKUP_SERVICE_USER" == root ]] || fail "The encrypted production backup service must run explicitly as root."
[[ "$BACKUP_SERVICE_EXEC" == *"/usr/local/sbin/ustore-production-backup.sh"* ]] || fail "The backup service does not execute the reviewed root-owned backup script."
[[ -n "$BACKUP_FRAGMENT_PATH" && -f "$BACKUP_FRAGMENT_PATH" && ! -L "$BACKUP_FRAGMENT_PATH" ]] || fail "The active backup systemd unit fragment is missing or is a symlink."
[[ -z "$BACKUP_DROP_IN_PATHS" ]] || fail "Backup service drop-in overrides exist and require separate review."
[[ "$BACKUP_PROTECT_SYSTEM" == strict ]] || fail "Backup service must effectively use ProtectSystem=strict."
[[ "$BACKUP_PROTECT_HOME" == yes ]] || fail "Backup service must effectively use ProtectHome=yes."
[[ "$BACKUP_NO_NEW_PRIVILEGES" == yes ]] || fail "Backup service must effectively use NoNewPrivileges=yes."
[[ "$BACKUP_PRIVATE_TMP" == yes ]] || fail "Backup service must effectively use PrivateTmp=yes."
[[ "$BACKUP_READ_WRITE_PATHS" == /opt/ustore-backups ]] || fail "Backup service write access must be limited to /opt/ustore-backups."
[[ "$BACKUP_UNIT_CREDENTIAL_DIRECTIVE" == 'LoadCredentialEncrypted=backup-passphrase:/etc/credstore.encrypted/ustore-backup-passphrase.cred' ]] || fail "The active Service section does not contain exactly the expected encrypted systemd credential directive."
[[ "$BACKUP_SUCCESS_LINE" == "BACKUP SUCCESS: "* && "$LATEST_VERIFIED_BACKUP_RUN_EPOCH" =~ ^[1-9][0-9]*$ ]] || fail "No recent integrity-verified BACKUP SUCCESS journal marker was found."


BACKUP_SCRIPT=/usr/local/sbin/ustore-production-backup.sh
BACKUP_CNF_DIR=/etc/ustore-telegram-bot
BACKUP_CNF=$BACKUP_CNF_DIR/backup.cnf
BACKUP_CREDENTIAL=/etc/credstore.encrypted/ustore-backup-passphrase.cred
if [[ -f "$BACKUP_SCRIPT" && ! -L "$BACKUP_SCRIPT" ]]; then
  stat -c 'backup_script owner=%U group=%G mode=%a' "$BACKUP_SCRIPT"
  [[ "$(stat -c '%U:%G:%a' "$BACKUP_SCRIPT")" == root:root:700 ]] || fail "Backup script must be root:root mode 700."
  for pattern in mysqldump --triggers '--defaults-extra-file="$CNF"' '--cipher-algo AES256' --decrypt 'gzip -t' 'BACKUP SUCCESS' 'CREDENTIALS_DIRECTORY'; do
    grep -Fq -- "$pattern" "$BACKUP_SCRIPT" || fail "Backup script is missing a required dump/encryption/integrity control."
  done
else
  fail "The root-owned production backup script is missing or is a symlink."
fi
if [[ -d "$BACKUP_CNF_DIR" && -f "$BACKUP_CNF" && -f "$BACKUP_CREDENTIAL" ]]; then
  stat -c 'backup_config_directory owner=%U group=%G mode=%a' "$BACKUP_CNF_DIR"
  stat -c 'backup_mysql_config owner=%U group=%G mode=%a' "$BACKUP_CNF"
  stat -c 'backup_encrypted_credential owner=%U group=%G mode=%a' "$BACKUP_CREDENTIAL"
  [[ ! -L "$BACKUP_CNF_DIR" && ! -L "$BACKUP_CNF" && ! -L "$BACKUP_CREDENTIAL" ]] || fail "Backup configuration or credential path contains a symlink."
  [[ "$(stat -c '%U:%G:%a' "$BACKUP_CNF_DIR")" == root:root:700 ]] || fail "Backup configuration directory must be root:root mode 700."
  [[ "$(stat -c '%U:%G:%a' "$BACKUP_CNF")" == root:root:600 ]] || fail "MySQL backup option file must be root:root mode 600."
  [[ "$(stat -c '%U:%G:%a' "$BACKUP_CREDENTIAL")" == root:root:600 ]] || fail "Encrypted backup passphrase credential must be root:root mode 600."
else
  fail "Protected MySQL backup configuration or encrypted passphrase credential is missing."
fi

if [[ "$MYSQL_READY" == 1 && -f "$BACKUP_CNF" && ! -L "$BACKUP_CNF" && -n "$APP_USER" && -n "${MIG_USER:-}" ]]; then
  BACKUP_IDENTITY="$(mysql --defaults-extra-file="$BACKUP_CNF" --protocol=TCP --database="$DB" --batch --skip-column-names -e 'SELECT CURRENT_USER(), DATABASE()' 2>/dev/null || true)"
  IFS=$'\t' read -r BACKUP_CURRENT_USER BACKUP_DB <<< "$BACKUP_IDENTITY"
  if [[ "$BACKUP_CURRENT_USER" =~ ^([A-Za-z0-9_]{1,32})@127\.0\.0\.1$ ]]; then
    BACKUP_USER="$(printf '%s' "$BACKUP_CURRENT_USER" | sed 's/@127\.0\.0\.1$//')"
  else
    BACKUP_USER=
  fi
  if [[ -n "$BACKUP_USER" && "$BACKUP_DB" == "$DB" && "$BACKUP_USER" != "$APP_USER" && "$BACKUP_USER" != "$MIG_USER" ]]; then
    B1="$(mysql_q "SELECT COUNT(*) FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$BACKUP_USER'),'@',QUOTE('127.0.0.1')) AND TABLE_SCHEMA='$DB'")"
    B2="$(mysql_q "SELECT COUNT(DISTINCT PRIVILEGE_TYPE) FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$BACKUP_USER'),'@',QUOTE('127.0.0.1')) AND TABLE_SCHEMA='$DB' AND PRIVILEGE_TYPE IN ('SELECT','SHOW VIEW','TRIGGER')")"
    B3="$(mysql_q "SELECT COUNT(*) FROM information_schema.USER_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$BACKUP_USER'),'@',QUOTE('127.0.0.1')) AND PRIVILEGE_TYPE<>'USAGE'")"
    B4="$(mysql_q "SELECT COUNT(*) FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$BACKUP_USER'),'@',QUOTE('127.0.0.1')) AND TABLE_SCHEMA<>'$DB'")"
    B5="$(mysql_q "SELECT COUNT(*) FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$BACKUP_USER'),'@',QUOTE('127.0.0.1'))")"
    B6="$(mysql_q "SELECT COUNT(*) FROM mysql.default_roles WHERE USER='$BACKUP_USER' AND HOST='127.0.0.1'")"
    B7="$(mysql_q "SELECT COUNT(*) FROM mysql.role_edges WHERE TO_USER='$BACKUP_USER' AND TO_HOST='127.0.0.1'")"
    B8="$(mysql_q "SELECT COUNT(*) FROM mysql.user WHERE User='$BACKUP_USER' AND Host<>'127.0.0.1'")"
    B9="$(mysql_q "SELECT COUNT(*) FROM mysql.proxies_priv WHERE User='$BACKUP_USER' AND Host='127.0.0.1'")"
    B10="$(mysql_q "SELECT COUNT(*) FROM information_schema.COLUMN_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$BACKUP_USER'),'@',QUOTE('127.0.0.1'))")"
    B11="$(mysql_q "SELECT COUNT(*) FROM mysql.procs_priv WHERE User='$BACKUP_USER' AND Host='127.0.0.1'")"
    B12="$(mysql_q "SELECT COUNT(*) FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$BACKUP_USER'),'@',QUOTE('127.0.0.1')) AND TABLE_SCHEMA='$DB' AND IS_GRANTABLE='YES'")"
    printf 'backup_schema_privilege_rows=%s expected=3\nbackup_required_privilege_types=%s expected=3\nbackup_global_privileges=%s expected=0\nbackup_other_schema_grants=%s expected=0\nbackup_table_grants=%s expected=0\nbackup_default_roles=%s expected=0\nbackup_granted_roles=%s expected=0\nbackup_alternate_host_accounts=%s expected=0\nbackup_proxy_grants=%s expected=0\nbackup_column_grants=%s expected=0\nbackup_routine_object_grants=%s expected=0\nbackup_grant_option_rows=%s expected=0\n' "$B1" "$B2" "$B3" "$B4" "$B5" "$B6" "$B7" "$B8" "$B9" "$B10" "$B11" "$B12"
    if [[ "$B1" != 3 || "$B2" != 3 || "$B3" != 0 || "$B4" != 0 || "$B5" != 0 || "$B6" != 0 || "$B7" != 0 || "$B8" != 0 || "$B9" != 0 || "$B10" != 0 || "$B11" != 0 || "$B12" != 0 ]]; then
      fail "Backup account is not proven least-privilege on exactly one host identity and one schema."
    fi
    info "backup_authentication=verified_as_expected_mysql_identity"
  else
    fail "Dedicated backup MySQL option file does not authenticate to the target schema as a distinct 127.0.0.1 account."
  fi
else
  fail "Dedicated backup MySQL option file cannot be authenticated or runtime/migration identities are unavailable."
fi

CRON_BACKUP_COUNT="$({ crontab -l -u root 2>/dev/null || true; grep -hE '^[[:space:]]*[^#]' /etc/cron.d/* /etc/cron.daily/* /etc/cron.hourly/* /etc/cron.weekly/* 2>/dev/null || true; } | grep -Eic 'mysqldump|mysqlpump|mariadb-dump' || true)"
printf 'database_backup_cron_references=%s (contents are not printed; cron alone does not prove a successful run)\n' "$CRON_BACKUP_COUNT"
MAX_BACKUP_AGE_SECONDS=$((26*60*60))
CURRENT_EPOCH="$(date +%s)"
if [[ "$LATEST_VERIFIED_BACKUP_RUN_EPOCH" =~ ^[1-9][0-9]*$ ]]; then
  BACKUP_RUN_AGE_SECONDS=$((CURRENT_EPOCH-LATEST_VERIFIED_BACKUP_RUN_EPOCH))
  printf 'latest_verified_backup_age_seconds=%s maximum=%s\n' "$BACKUP_RUN_AGE_SECONDS" "$MAX_BACKUP_AGE_SECONDS"
  if [[ "$BACKUP_RUN_AGE_SECONDS" -lt 0 || "$BACKUP_RUN_AGE_SECONDS" -gt "$MAX_BACKUP_AGE_SECONDS" ]]; then
    fail "Latest successful encrypted database backup is older than the 26-hour recovery-point limit."
  fi
else
  fail "No valid successful backup timestamp could be parsed from the backup service journal."
fi
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
    DRAW_KEY_USAGE="UNKNOWN"
    if [[ "${MYSQL_READY:-0}" == 1 && "${DB:-}" =~ ^[A-Za-z0-9_]{1,64}$ ]]; then
      DRAW_KEY_USAGE="$(mysql_q "SELECT COUNT(*), COALESCE(SUM(seed_ciphertext IS NOT NULL AND seed_ciphertext<>''),0) FROM \`$DB\`.campaign_draws" 2>/dev/null || echo UNKNOWN)"
    fi
    IFS=
else
  fail "Protected draw-key backup directory is missing."
fi
BACKUP_SCAN_DIRS=(/root /var/backups /opt/ustore-backups /opt/ustore-release-backup-*)
ENCRYPTED_DB_BACKUPS=0
LATEST_ENCRYPTED_DB_BACKUP_EPOCH=0
LATEST_ENCRYPTED_DB_BACKUP_PATH=
for directory in "${BACKUP_SCAN_DIRS[@]}"; do
  [[ -d "$directory" ]] || continue
  while IFS= read -r -d '' artifact; do
    ENCRYPTED_DB_BACKUPS=$((ENCRYPTED_DB_BACKUPS+1))
    artifact_epoch="$(stat -c '%Y' "$artifact" 2>/dev/null || echo 0)"
    if [[ "$artifact_epoch" =~ ^[0-9]+$ && "$artifact_epoch" -gt "$LATEST_ENCRYPTED_DB_BACKUP_EPOCH" ]]; then
      LATEST_ENCRYPTED_DB_BACKUP_EPOCH="$artifact_epoch"
      LATEST_ENCRYPTED_DB_BACKUP_PATH="$artifact"
    fi
  done < <(find "$directory" -maxdepth 5 -type f \( -iname '*.sql.gpg' -o -iname '*.sql.age' -o -iname '*.sql.enc' -o -iname '*.sql.gz.gpg' -o -iname '*.sql.gz.age' -o -iname '*.sql.gz.enc' -o -iname '*.sql.zst.gpg' -o -iname '*.sql.zst.age' -o -iname '*.sql.zst.enc' -o -iname '*backup*.tar.gpg' -o -iname '*backup*.tar.age' -o -iname '*backup*.tar.enc' -o -iname '*backup*.tar.gz.gpg' -o -iname '*backup*.tar.gz.age' -o -iname '*backup*.tar.gz.enc' -o -iname '*backup*.tar.zst.gpg' -o -iname '*backup*.tar.zst.age' -o -iname '*backup*.tar.zst.enc' -o -iname '*backup*.zip.gpg' -o -iname '*backup*.zip.age' -o -iname '*backup*.zip.enc' -o -iname '*.dump.gpg' -o -iname '*.dump.age' -o -iname '*.dump.enc' \) -print0)
done
printf 'encrypted_database_backup_artifacts=%s latest_artifact_epoch=%s latest_artifact_path=%s (inspected local paths; off-host evidence must be checked separately)\n' "$ENCRYPTED_DB_BACKUPS" "$LATEST_ENCRYPTED_DB_BACKUP_EPOCH" "${LATEST_ENCRYPTED_DB_BACKUP_PATH:-not_found}"
if [[ "$ENCRYPTED_DB_BACKUPS" -eq 0 ]]; then fail "No encrypted database backup artifact was detected in the inspected local paths."; fi
BACKUP_ARTIFACT_RUN_DELTA=$((LATEST_ENCRYPTED_DB_BACKUP_EPOCH-LATEST_VERIFIED_BACKUP_RUN_EPOCH))
printf 'encrypted_backup_artifact_run_delta_seconds=%s allowed_range=-300..300\n' "$BACKUP_ARTIFACT_RUN_DELTA"
if [[ "$LATEST_VERIFIED_BACKUP_RUN_EPOCH" -eq 0 || "$BACKUP_ARTIFACT_RUN_DELTA" -lt -300 || "$BACKUP_ARTIFACT_RUN_DELTA" -gt 300 ]]; then
  fail "The latest encrypted database backup artifact timestamp does not match the latest verified successful backup timer run within five minutes."
fi

PLAINTEXT_DB_BACKUPS=0
for directory in "${BACKUP_SCAN_DIRS[@]}"; do
  [[ -d "$directory" ]] || continue
  count="$(find "$directory" -maxdepth 5 -type f \( -iname '*backup*.sql' -o -iname '*backup*.sql.gz' -o -iname '*backup*.sql.zst' -o -iname '*backup*.sql.xz' -o -iname '*backup*.sql.bz2' -o -iname '*before-reset*.sql' -o -iname '*before-reset*.sql.gz' -o -iname '*dump*.sql' -o -iname '*dump*.sql.gz' -o -iname '*backup*.dump' -o -iname '*backup*.dump.gz' -o -iname '*backup*.tar' -o -iname '*backup*.tar.gz' -o -iname '*backup*.tar.zst' -o -iname '*backup*.zip' -o \( \( -path '*/ustore-*backup*/*' -o -path '*/var/backups/*' -o -path '*/ustore-backups/*' \) -a \( -iname '*.sql' -o -iname '*.sql.gz' -o -iname '*.sql.zst' -o -iname '*.sql.xz' -o -iname '*.sql.bz2' -o -iname '*.dump' -o -iname '*.dump.gz' -o -iname '*.dump.zst' -o -iname '*.dump.xz' -o -iname '*.dump.bz2' \) \) \) -printf '.' | wc -c)"
  PLAINTEXT_DB_BACKUPS=$((PLAINTEXT_DB_BACKUPS+count))
done
printf 'plaintext_database_backup_artifacts=%s expected=0\n' "$PLAINTEXT_DB_BACKUPS"
if [[ "$PLAINTEXT_DB_BACKUPS" -gt 0 ]]; then fail "Unencrypted database or full-backup archives were detected; compression alone is not encryption."; fi

section "NETWORK AND FIREWALL"
if command -v ufw >/dev/null 2>&1; then
  UFW_STATUS="$(ufw status verbose 2>&1 || true)"
  if grep -q '^Status: active$' <<< "$UFW_STATUS"; then
    info "ufw=active"
  else
    info "ufw=inactive; activation_deferred_until_post_release"
  fi
else
  info "ufw=not_installed; activation_deferred_until_post_release"
fi
printf 'listening_tcp_ports:\n'
ss -lntp 2>/dev/null | awk 'NR==1 || /LISTEN/'
info "UFW activation is intentionally deferred until a separate post-release SSH-safe maintenance window."
info "Verify provider-level firewall rules independently; this preflight does not claim that an external firewall is active."
section "RESULT"
if [[ "$FAILURES" -eq 0 ]]; then
  info "HOST_CHECKS=PASS (does not replace staging, restore, privacy/legal, or load-test approval)"
else
  printf 'HOST_CHECKS=BLOCKED failures=%s\n' "$FAILURES"
  exit 1
fi
\t' read -r DRAW_RECORDS DRAW_ENCRYPTED_SEEDS <<< "$DRAW_KEY_USAGE"
    if [[ "$DRAW_RECORDS" =~ ^[0-9]+$ && "$DRAW_ENCRYPTED_SEEDS" =~ ^[0-9]+$ && "$DRAW_RECORDS" == 0 && "$DRAW_ENCRYPTED_SEEDS" == 0 ]]; then
      while IFS= read -r key_file; do
        [[ -n "$key_file" ]] || continue
        [[ ! -L "$key_file" ]] || fail "A retained plaintext draw-key backup is a symlink."
        [[ "$(stat -c '%U:%G:%a' "$key_file")" == root:root:600 ]] || fail "A retained plaintext draw-key backup must be root:root mode 600."
      done <<< "$PLAINTEXT_KEY_FILES"
      info "plaintext_draw_key_backups=retained_root_only_no_draw_records; cleanup_deferred"
    else
      printf 'draw_key_usage_records=%s encrypted_seeds=%s\n' "${DRAW_RECORDS:-UNKNOWN}" "${DRAW_ENCRYPTED_SEEDS:-UNKNOWN}"
      fail "Plaintext draw-key backups remain while draw records exist or their usage could not be verified."
    fi
  fi
  ENCRYPTED_KEY_FILES="$(find "$KEY_BACKUP_DIR" -maxdepth 1 -type f \( -name '*.gpg' -o -name '*.age' -o -name '*.enc' \) -print)"
  if [[ -z "$ENCRYPTED_KEY_FILES" ]]; then
    fail "No encrypted draw-key backup artifact was detected."
  else
    while IFS= read -r key_file; do
      [[ -n "$key_file" ]] || continue
      [[ ! -L "$key_file" ]] || fail "An encrypted draw-key backup is a symlink."
      [[ "$(stat -c '%U:%G:%a' "$key_file")" == root:root:600 ]] || fail "Encrypted draw-key backups must be root:root mode 600."
    done <<< "$ENCRYPTED_KEY_FILES"
  fi
else
  fail "Protected draw-key backup directory is missing."
fi
BACKUP_SCAN_DIRS=(/root /var/backups /opt/ustore-backups /opt/ustore-release-backup-*)
ENCRYPTED_DB_BACKUPS=0
LATEST_ENCRYPTED_DB_BACKUP_EPOCH=0
LATEST_ENCRYPTED_DB_BACKUP_PATH=
for directory in "${BACKUP_SCAN_DIRS[@]}"; do
  [[ -d "$directory" ]] || continue
  while IFS= read -r -d '' artifact; do
    ENCRYPTED_DB_BACKUPS=$((ENCRYPTED_DB_BACKUPS+1))
    artifact_epoch="$(stat -c '%Y' "$artifact" 2>/dev/null || echo 0)"
    if [[ "$artifact_epoch" =~ ^[0-9]+$ && "$artifact_epoch" -gt "$LATEST_ENCRYPTED_DB_BACKUP_EPOCH" ]]; then
      LATEST_ENCRYPTED_DB_BACKUP_EPOCH="$artifact_epoch"
      LATEST_ENCRYPTED_DB_BACKUP_PATH="$artifact"
    fi
  done < <(find "$directory" -maxdepth 5 -type f \( -iname '*.sql.gpg' -o -iname '*.sql.age' -o -iname '*.sql.enc' -o -iname '*.sql.gz.gpg' -o -iname '*.sql.gz.age' -o -iname '*.sql.gz.enc' -o -iname '*.sql.zst.gpg' -o -iname '*.sql.zst.age' -o -iname '*.sql.zst.enc' -o -iname '*backup*.tar.gpg' -o -iname '*backup*.tar.age' -o -iname '*backup*.tar.enc' -o -iname '*backup*.tar.gz.gpg' -o -iname '*backup*.tar.gz.age' -o -iname '*backup*.tar.gz.enc' -o -iname '*backup*.tar.zst.gpg' -o -iname '*backup*.tar.zst.age' -o -iname '*backup*.tar.zst.enc' -o -iname '*backup*.zip.gpg' -o -iname '*backup*.zip.age' -o -iname '*backup*.zip.enc' -o -iname '*.dump.gpg' -o -iname '*.dump.age' -o -iname '*.dump.enc' \) -print0)
done
printf 'encrypted_database_backup_artifacts=%s latest_artifact_epoch=%s latest_artifact_path=%s (inspected local paths; off-host evidence must be checked separately)\n' "$ENCRYPTED_DB_BACKUPS" "$LATEST_ENCRYPTED_DB_BACKUP_EPOCH" "${LATEST_ENCRYPTED_DB_BACKUP_PATH:-not_found}"
if [[ "$ENCRYPTED_DB_BACKUPS" -eq 0 ]]; then fail "No encrypted database backup artifact was detected in the inspected local paths."; fi
BACKUP_ARTIFACT_RUN_DELTA=$((LATEST_ENCRYPTED_DB_BACKUP_EPOCH-LATEST_VERIFIED_BACKUP_RUN_EPOCH))
printf 'encrypted_backup_artifact_run_delta_seconds=%s allowed_range=-300..300\n' "$BACKUP_ARTIFACT_RUN_DELTA"
if [[ "$LATEST_VERIFIED_BACKUP_RUN_EPOCH" -eq 0 || "$BACKUP_ARTIFACT_RUN_DELTA" -lt -300 || "$BACKUP_ARTIFACT_RUN_DELTA" -gt 300 ]]; then
  fail "The latest encrypted database backup artifact timestamp does not match the latest verified successful backup timer run within five minutes."
fi

PLAINTEXT_DB_BACKUPS=0
for directory in "${BACKUP_SCAN_DIRS[@]}"; do
  [[ -d "$directory" ]] || continue
  count="$(find "$directory" -maxdepth 5 -type f \( -iname '*backup*.sql' -o -iname '*backup*.sql.gz' -o -iname '*backup*.sql.zst' -o -iname '*backup*.sql.xz' -o -iname '*backup*.sql.bz2' -o -iname '*before-reset*.sql' -o -iname '*before-reset*.sql.gz' -o -iname '*dump*.sql' -o -iname '*dump*.sql.gz' -o -iname '*backup*.dump' -o -iname '*backup*.dump.gz' -o -iname '*backup*.tar' -o -iname '*backup*.tar.gz' -o -iname '*backup*.tar.zst' -o -iname '*backup*.zip' -o \( \( -path '*/ustore-*backup*/*' -o -path '*/var/backups/*' -o -path '*/ustore-backups/*' \) -a \( -iname '*.sql' -o -iname '*.sql.gz' -o -iname '*.sql.zst' -o -iname '*.sql.xz' -o -iname '*.sql.bz2' -o -iname '*.dump' -o -iname '*.dump.gz' -o -iname '*.dump.zst' -o -iname '*.dump.xz' -o -iname '*.dump.bz2' \) \) \) -printf '.' | wc -c)"
  PLAINTEXT_DB_BACKUPS=$((PLAINTEXT_DB_BACKUPS+count))
done
printf 'plaintext_database_backup_artifacts=%s expected=0\n' "$PLAINTEXT_DB_BACKUPS"
if [[ "$PLAINTEXT_DB_BACKUPS" -gt 0 ]]; then fail "Unencrypted database or full-backup archives were detected; compression alone is not encryption."; fi

section "NETWORK AND FIREWALL"
if ! command -v ufw >/dev/null 2>&1; then
  fail "UFW is not installed; a host firewall is required for the public SSH-facing production host."
else
  UFW_STATUS="$(ufw status verbose 2>&1 || true)"
  printf '%s\n' "$UFW_STATUS"
  if ! grep -q '^Status: active$' <<< "$UFW_STATUS"; then
    fail "UFW must be active; do not rely on an unverified provider-level firewall."
  else
    grep -Eq '^Default: deny \(incoming\), allow \(outgoing\)' <<< "$UFW_STATUS" || fail "UFW defaults must deny inbound traffic and allow outbound Telegram/database traffic."
    SSH_PORTS="$(sshd -T 2>/dev/null | awk '$1=="port" {print $2}' | sort -nu || true)"
    if [[ -z "$SSH_PORTS" ]]; then
      fail "Could not determine the effective SSH listening port; refusing to approve firewall rules."
    else
      UFW_RULES="$UFW_STATUS" # Preserve ALLOW IN direction from verbose output.
      while IFS= read -r port; do
        [[ -n "$port" ]] || continue
        if ! awk -v p="$port" '$1==p"/tcp" && $2=="ALLOW" && $3=="IN" {found=1} END{exit !found}' <<< "$UFW_RULES"; then
          fail "UFW does not explicitly allow the effective SSH port ${port}/tcp; preserve SSH access before changing firewall policy."
        fi
      done <<< "$SSH_PORTS"
      EXTRA_INBOUND_ALLOWS="$(awk '$2=="ALLOW" && $3=="IN" {print $1}' <<< "$UFW_RULES" | while IFS= read -r rule; do
        allowed=0
        while IFS= read -r port; do [[ "$rule" == "$port/tcp" ]] && allowed=1; done <<< "$SSH_PORTS"
        [[ "$allowed" == 1 ]] || printf '%s\n' "$rule"
      done)"
      if [[ -n "$EXTRA_INBOUND_ALLOWS" ]]; then
        printf 'unexpected_inbound_allow_rules:\n%s\n' "$EXTRA_INBOUND_ALLOWS"
        fail "The Telegram long-polling host must not expose additional inbound services."
      fi
    fi
  fi
fi
printf 'listening_tcp_ports:\n'
ss -lntp 2>/dev/null | awk 'NR==1 || /LISTEN/'
info "Provider-level firewall status remains an independent hosting-control-panel check."

section "RESULT"
if [[ "$FAILURES" -eq 0 ]]; then
  info "HOST_CHECKS=PASS (does not replace staging, restore, privacy/legal, or load-test approval)"
else
  printf 'HOST_CHECKS=BLOCKED failures=%s\n' "$FAILURES"
  exit 1
fi
