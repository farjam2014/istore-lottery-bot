import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const installerPath=fileURLToPath(new URL('../install.sh',import.meta.url));

test('Ubuntu installer has valid Bash syntax',()=>{
  const result=spawnSync('bash',['-n',installerPath],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr||result.stdout||'bash -n failed');
});

test('installer preserves existing application state and requires production authorization',()=>{
  const script=readFileSync(installerPath,'utf8');
  assert.match(script,/git -C .*status --porcelain --untracked-files=all/);
  assert.match(script,/Tracked or untracked files are present in the checkout/);
  assert.doesNotMatch(script,/unexpected origin remote: \$remote/,'Installer must not print a remote URL that could contain embedded credentials.');
  assert.match(script,/Existing \.env found; preserving it/);
  assert.match(script,/CREATE DATABASE IF NOT EXISTS/);
  assert.match(script,/ALLOW_DATABASE_MIGRATIONS/);
  assert.match(script,/ALLOW_PRODUCTION_MIGRATIONS/);
  assert.match(script,/MIGRATION_TARGET_DATABASE/);
  assert.match(script,/NODE_ENV_VALUE="\$\{NODE_ENV_VALUE:-production\}"/);
  assert.match(script,/NODE_ENV_VALUE" == "production"/);
  assert.match(script,/Production installer requires NODE_ENV=production/);
  assert.ok(script.indexOf('ALLOW_DATABASE_MIGRATIONS') < script.indexOf('CREATE DATABASE IF NOT EXISTS'),'Installer must authorize database changes before provisioning MySQL.');
  assert.doesNotMatch(script,/DROP DATABASE/i);
  assert.match(script,/npm ci --omit=dev/,'Installer must use the committed lockfile without dependency resolution drift.');
  assert.match(script,/--property=ActiveState/);
  assert.match(script,/--property=SubState/);
  assert.match(script,/--property=MainPID/);
  assert.match(script,/Telegram bot launched with long polling/);
  assert.doesNotMatch(script,/rm -rf/);
  const unitPreflight=script.indexOf('grep -Fq "WorkingDirectory=$APP_DIR"');
  const activePreflight=script.indexOf('Active $SERVICE uses WorkingDirectory');
  const aptInstall=script.indexOf('apt-get update');
  assert.ok(activePreflight>=0&&activePreflight<aptInstall,'Active service path must be validated before installing prerequisites.');
  const stopService=script.indexOf('systemctl stop "$SERVICE"');
  assert.ok(unitPreflight>=0&&unitPreflight<stopService,'Existing service target must be validated before the service is stopped.');
  const updateCheckout=script.indexOf('git -C "$APP_DIR" fetch');
  const migrateDatabase=script.indexOf('npm run db:migrate');
  assert.ok(stopService>=0&&stopService<updateCheckout&&stopService<migrateDatabase,'An active service must stop before source checkout updates and production migrations.');
});

test('production migration preflight includes campaign-edit wizard migration and schema check',()=>{
  const preflight=readFileSync(new URL('../scripts/production-migration-preflight.sql',import.meta.url),'utf8');
  const readiness=readFileSync(new URL('../docs/RELEASE_READINESS.md',import.meta.url),'utf8');
  assert.ok(preflight.includes('20261119_001_campaign_edit_wizard_step.sql'));
  assert.ok(preflight.includes("table_name='admin_wizards' AND column_name='step'"));
  assert.ok(readiness.includes('20261119_001_campaign_edit_wizard_step.sql'));
  assert.ok(readiness.includes('Campaign editing opens the input prompt'));
});


test('fresh installation requires and writes a published privacy notice',()=>{
  const script=readFileSync(installerPath,'utf8');
  assert.match(script,/Published HTTPS privacy notice URL/);
  assert.match(script,/PRIVACY_NOTICE_URL=\$PRIVACY_NOTICE_URL/);
  assert.match(script,/PRIVACY_NOTICE_VERSION=\$PRIVACY_NOTICE_VERSION/);
  assert.match(script,/PRIVACY_NOTICE_URL must be a published, non-placeholder HTTPS URL/);
  assert.match(script,/PRIVACY_NOTICE_VERSION in \.env is missing or invalid/);
});

test('installer keeps DDL privileges on a separate root-protected migration account',()=>{
  const script=readFileSync(installerPath,'utf8');
  assert.match(script,/GRANT SELECT, INSERT, UPDATE, DELETE ON \$DB_NAME\.\* TO '\$DB_USER'@'127\.0\.0\.1'/);
  assert.doesNotMatch(script,/GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON \$DB_NAME\.\* TO '\$DB_USER'/);
  assert.match(script,/GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON \$DB_NAME\.\* TO '\$MIGRATION_DB_USER'/);
  assert.match(script,/MIGRATION_ENV_DIR="\/etc\/ustore-telegram-bot"/);
  assert.match(script,/stat -c '%U:%G:%a' "\$MIGRATION_ENV_FILE"\)" == "root:root:600"/);
  assert.match(script,/MYSQL_MIGRATION_PASSWORD=\$MIGRATION_DB_PASSWORD/);
  assert.ok(script.includes('admin_ids_csv="${ADMIN_ID//[[:space:]]/}"'));
  assert.ok(script.includes('[[ "$admin_ids_csv" =~ ^[0-9]{5,20}(,[0-9]{5,20})*$ ]]'));
});


test('installer refuses migration credentials in the service-readable runtime env',()=>{
  const script=readFileSync(installerPath,'utf8');
  assert.match(script,/read_env MYSQL_MIGRATION_USER/);
  assert.match(script,/read_env MYSQL_MIGRATION_PASSWORD/);
  assert.match(script,/Migration credentials must not be stored in the service-readable runtime \.env/);
});
