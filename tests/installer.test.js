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
  assert.match(script,/git -C .*status --porcelain --untracked-files=no/);
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
  assert.doesNotMatch(script,/rm -rf/);
  const stopService=script.indexOf('systemctl stop "$SERVICE"');
  const updateCheckout=script.indexOf('git -C "$APP_DIR" fetch');
  const migrateDatabase=script.indexOf('npm run db:migrate');
  assert.ok(stopService>=0&&stopService<updateCheckout&&stopService<migrateDatabase,'An active service must stop before source checkout updates and production migrations.');
});
