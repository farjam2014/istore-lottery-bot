import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../../scripts/production-host-preflight.sh',import.meta.url),'utf8');

test('production host preflight rejects role grants and alternate host identities for both DB accounts',()=>{
  assert.match(source,/mysql\.role_edges WHERE TO_USER='\$APP_USER' AND TO_HOST='127\.0\.0\.1'/);
  assert.match(source,/mysql\.role_edges WHERE TO_USER='\$MIG_USER' AND TO_HOST='127\.0\.0\.1'/);
  assert.match(source,/mysql\.user WHERE User='\$APP_USER' AND Host<>'127\.0\.0\.1'/);
  assert.match(source,/mysql\.user WHERE User='\$MIG_USER' AND Host<>'127\.0\.0\.1'/);
  assert.match(source,/mysql\.proxies_priv WHERE User='\$APP_USER'/);
  assert.match(source,/mysql\.proxies_priv WHERE User='\$MIG_USER'/);
  assert.match(source,/runtime_granted_roles=%s expected=0/);
  assert.match(source,/runtime_alternate_host_accounts=%s expected=0/);
  assert.match(source,/migration_granted_roles=%s expected=0/);
  assert.match(source,/migration_alternate_host_accounts=%s expected=0/);
});

test('self-hosted runner account must have no sudo command grants, not merely no NOPASSWD grant',()=>{
  assert.match(source,/sudo -l -U ghrunner/);
  assert.ok(source.includes(String.raw`grep -Eq '^[[:space:]]*\([^)]*\)[[:space:]]'`));
  assert.match(source,/ghrunner has sudo command grants/);
  assert.match(source,/Could not reliably inspect ghrunner sudo policy/);
  assert.doesNotMatch(source,/grep -q NOPASSWD/);
});

test('any remaining privileged helper must be root-owned and not writable or setuid/setgid by non-root users',()=>{
  assert.match(source,/stat -c '%U:%G' \/usr\/local\/sbin\/istore-admin/);
  assert.match(source,/== "root:root"/);
  assert.match(source,/find \/usr\/local\/sbin\/istore-admin -maxdepth 0 -perm \/6022/);
});


test('runner sudo inspection treats the expected no-sudo response as safe and fails closed on unknown errors',()=>{
  assert.ok(source.includes('GHrunner_SUDO_STATUS=0'));
  assert.ok(source.includes('sudo -l -U ghrunner 2>&1'));
  assert.ok(source.includes('not allowed to run sudo|may not run sudo|not in the sudoers file'));
  assert.ok(source.includes('ghrunner_sudo=none_detected'));
  assert.ok(source.includes('Could not reliably inspect ghrunner sudo policy.'));
});

test('production host preflight requires a dedicated service identity and effective systemd sandbox controls',()=>{
  for(const value of [
    'SERVICE_USER="$(systemctl show "$SERVICE" -p User --value',
    'SERVICE_GROUP="$(systemctl show "$SERVICE" -p Group --value',
    '[[ "$SERVICE_USER" == "ustorebot" ]] || fail',
    '[[ "$SERVICE_GROUP" == "ustorebot" ]] || fail',
    '[[ "$NO_NEW_PRIVILEGES" == "yes" ]] || fail',
    '[[ "$PRIVATE_TMP" == "yes" ]] || fail',
    '[[ "$PROTECT_SYSTEM" == "strict" ]] || fail',
    '[[ -z "$READ_WRITE_PATHS" ]] && info "systemd_read_write_paths=none" || fail',
    '[[ "$PROTECT_HOME" == "yes" ]] || fail',
    'systemd service must not have any writable filesystem exceptions; use PrivateTmp for ephemeral files.',
    'systemd ExecStart must target the active release entry point.',
    'Live process working directory differs from the active release path.',
    'Live process is not running as ustorebot.',
    'ustorebot:ustorebot:600'
  ]) assert.ok(source.includes(value), 'missing host hardening assertion: '+value);
});


test('backup preflight requires an enabled app-database timer and a recorded successful service run',()=>{
  for(const value of [
    'VERIFIED_BACKUP_TIMER_COUNT=0',
    'systemctl is-active "$timer"',
    'systemctl is-enabled "$timer"',
    'systemctl show "$service" -p Result --value',
    'systemctl show "$service" -p ExecMainStatus --value',
    'systemctl show "$service" -p ExecMainExitTimestamp --value',
    'service_result" == "success"',
    'service_exit" == "0"',
    'cron alone does not prove a successful run'
  ]) assert.ok(source.includes(value), 'missing backup verification gate: '+value);
  assert.ok(source.includes('tolower($(NF-1)) ~ /(ustore|mysql|mariadb|database).*backup|backup.*(ustore|mysql|mariadb|database)/'));
});


test('backup artifact scan accepts directly encrypted SQL dumps as well as compressed encrypted dumps',()=>{
  for(const extension of ["*.sql.gpg","*.sql.age","*.sql.enc","*.sql.gz.gpg","*.sql.gz.age","*.sql.gz.enc"]) assert.ok(source.includes("-iname '"+extension+"'"));
});
test('backup artifact must be fresh relative to the latest successful encrypted backup timer run',()=>{
  assert.ok(source.includes('LATEST_VERIFIED_BACKUP_RUN_EPOCH=0'));
  assert.ok(source.includes('date -d "$service_last_run" +%s'));
  assert.ok(source.includes('LATEST_ENCRYPTED_DB_BACKUP_EPOCH=0'));
  assert.ok(source.includes("stat -c '%Y' \"$artifact\""));
  assert.ok(source.includes('BACKUP_ARTIFACT_RUN_DELTA=$((LATEST_ENCRYPTED_DB_BACKUP_EPOCH-LATEST_VERIFIED_BACKUP_RUN_EPOCH))'));
  assert.ok(source.includes('BACKUP_ARTIFACT_RUN_DELTA" -lt -300 || "$BACKUP_ARTIFACT_RUN_DELTA" -gt 300'));
  assert.ok(source.includes('timestamp does not match the latest verified successful backup timer run within five minutes'));
});
test('backup timer service must directly expose a database dump command before it counts as verified',()=>{
  assert.ok(source.includes('systemctl show "$service" -p ExecStart --value'));
  assert.ok(source.includes('(mysqldump|mysqlpump|mariadb-dump)'));
  assert.ok(source.includes('dump_command=database_dump_detected'));
  assert.ok(source.includes('last_successful_process_exit=%s dump_command=%s'));
  assert.ok(source.includes('"$dump_command" == "database_dump_detected"'));
  assert.ok(source.includes('directly verifiable database dump command'));
});

test('backup timer must expose both database dump and encryption commands in its effective ExecStart',()=>{
  assert.ok(source.includes('encryption_command=not_proven'));
  assert.ok(source.includes('(gpg|age|openssl[[:space:]]+enc)'));
  assert.ok(source.includes('encryption_command=backup_encryption_detected'));
  assert.ok(source.includes('"$encryption_command" == "backup_encryption_detected"'));
  assert.ok(source.includes('encryption_command=%s'));
  assert.ok(source.includes('visible encryption command'));
});


test('database preflight authenticates runtime and migration credentials without putting passwords in argv or output',()=>{
  assert.ok(source.includes('verify_mysql_identity(){'));
  assert.ok(source.includes("const mysql=require('mysql2/promise');"));
  assert.ok(source.includes("connection=await mysql.createConnection({host,port,user,password,database,connectTimeout:5000});"));
  assert.ok(source.includes("SELECT CURRENT_USER() AS account, DATABASE() AS schema_name"));
  assert.ok(source.includes("identity.account!==user+'@'+host"));
  assert.ok(source.includes("label+'_authentication=verified\\n'"));
  assert.ok(source.includes("label+'_authentication=verified\\n'"));
  assert.ok(source.includes('verify_mysql_identity "$ACTIVE" "$ACTIVE/.env" "$ACTIVE/.env" MYSQL_USER MYSQL_PASSWORD MYSQL_DATABASE runtime'));
  assert.ok(source.includes('verify_mysql_identity "$ACTIVE" "$ACTIVE/.env" "$MIGRATION_ENV" MYSQL_MIGRATION_USER MYSQL_MIGRATION_PASSWORD MIGRATION_TARGET_DATABASE migration'));
  assert.ok(source.includes('unset APP_PASS'));
  assert.ok(source.indexOf('"$MIG_PASS" != "$APP_PASS"') < source.indexOf('unset APP_PASS'),'runtime password comparison must happen before clearing the runtime password');
  assert.doesNotMatch(source,/MYSQL_PASSWORD=[^\\s]+/);
  assert.doesNotMatch(source,/MYSQL_MIGRATION_PASSWORD=[^\\s]+/);
});


test('database privilege preflight rejects object-level column, routine and event grants for both identities',()=>{
  for(const table of ['COLUMN_PRIVILEGES']){
    assert.ok(source.includes('information_schema.'+table));
  }
  for(const field of ['R11','R12','M10','M11']) assert.ok(source.includes(field+'="$(mysql_q'));
  assert.ok(source.includes('runtime_column_grants=%s expected=0'));
  assert.ok(source.includes('runtime_routine_object_grants=%s expected=0'));
  assert.ok(source.includes('migration_column_grants=%s expected=0'));
  assert.ok(source.includes('migration_routine_object_grants=%s expected=0'));
  assert.ok(source.includes("mysql.procs_priv WHERE User='$APP_USER' AND Host='127.0.0.1'"));
  assert.ok(source.includes("mysql.procs_priv WHERE User='$MIG_USER' AND Host='127.0.0.1'"));
  assert.doesNotMatch(source,/ROUTINE_PRIVILEGES|EVENT_PRIVILEGES/);
});


test('backup artifact scan includes historical root-level SQL dumps and unencrypted full-backup archives',()=>{
  assert.ok(source.includes('BACKUP_SCAN_DIRS=(/root /var/backups /opt/ustore-backups /opt/ustore-release-backup-*)'));
  assert.ok(source.includes("-iname '*backup*.sql'"));
  assert.ok(source.includes("-iname '*before-reset*.sql'"));
  assert.ok(source.includes("-iname '*backup*.tar.gz'"));
  assert.ok(source.includes("-iname '*backup*.tar.gz.gpg'"));
  assert.ok(source.includes('Unencrypted database or full-backup archives were detected'));
});


test('production host preflight detects manually launched GitHub runner processes and searches common runner install roots',()=>{
  assert.ok(source.includes('for command in systemctl stat node mysql ss free df awk grep find wc sort date hostname readlink id sudo crontab curl pgrep tr sed; do'));
  assert.ok(source.includes("pgrep -f '[R]unner.Listener'"));
  assert.ok(source.includes("pgrep -f '[R]unner.Worker'"));
  assert.ok(source.includes('runner_process_ids='));
  assert.ok(source.includes('runner_processes=none_detected'));
  assert.ok(source.includes('find /home /opt /root /srv /var/lib /usr/local -maxdepth 6 -type f'));
});


test('production host preflight verifies binary-log trust before least-privilege audit-trigger migrations',()=>{
  assert.ok(source.includes("BINLOG_ENABLED=\"$(mysql_q 'SELECT @@GLOBAL.log_bin'"));
  assert.ok(source.includes("BINLOG_TRUSTED_CREATORS=\"$(mysql_q 'SELECT @@GLOBAL.log_bin_trust_function_creators'"));
  assert.ok(source.includes('MySQL binary logging is enabled but log_bin_trust_function_creators is OFF'));
  assert.ok(source.includes('append-only audit trigger migrations would require broader privileges.'));
});


test('backup preflight rejects a successful but stale database backup run',()=>{
  assert.ok(source.includes('MAX_BACKUP_AGE_SECONDS=$((26*60*60))'));
  assert.ok(source.includes('BACKUP_RUN_AGE_SECONDS=$((CURRENT_EPOCH-LATEST_VERIFIED_BACKUP_RUN_EPOCH))'));
  assert.ok(source.includes('BACKUP_RUN_AGE_SECONDS" -gt "$MAX_BACKUP_AGE_SECONDS"'));
  assert.ok(source.includes('Latest successful encrypted database backup is older than the 26-hour recovery-point limit.'));
});


test('production host preflight rejects schema-level GRANT OPTION for runtime and migration identities',()=>{
  assert.ok(source.includes("AND IS_GRANTABLE='YES'"));
  assert.ok(source.includes('runtime_grant_option_rows=%s expected=0'));
  assert.ok(source.includes('migration_grant_option_rows=%s expected=0'));
  assert.ok(source.includes('"$R13" != 0'));
  assert.ok(source.includes('"$M12" != 0'));
});


test('production host preflight prints backup age and artifact delta as separate output lines',()=>{
  assert.ok(source.includes(String.raw`latest_verified_backup_age_seconds=%s maximum=%s\n`));
  assert.ok(source.includes(String.raw`encrypted_backup_artifact_run_delta_seconds=%s allowed_range=-300..300\n`));
});


test('production host preflight requires active default-deny UFW and explicit SSH-only inbound access',()=>{
  for(const value of [
    'UFW is not installed; a host firewall is required',
    "grep -q '^Status: active$'",
    "^Default: deny \\(incoming\\), allow \\(outgoing\\)",
    'sshd -T 2>/dev/null',
    'UFW does not explicitly allow the effective SSH port',
    'EXTRA_INBOUND_ALLOWS=',
    'The Telegram long-polling host must not expose additional inbound services.'
  ]) assert.ok(source.includes(value), 'missing firewall gate: '+value);
  assert.ok(source.includes("$1==p\"/tcp\" && $2==\"ALLOW\" && $3==\"IN\""));
});


test('production host preflight parses inbound UFW rules from verbose status including direction',()=>{
  assert.ok(source.includes('UFW_RULES="$UFW_STATUS"'));
  assert.ok(source.includes("$2==\\\"ALLOW\\\" && $3==\\\"IN\\\""));
  assert.ok(!source.includes('UFW_RULES="$(ufw status 2>/dev/null || true)"'));
});
