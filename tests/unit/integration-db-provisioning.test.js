import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const prepare=readFileSync(new URL('../../scripts/prepare-integration-db.sh',import.meta.url),'utf8');
const runner=readFileSync(new URL('../../scripts/run-integration-tests.sh',import.meta.url),'utf8');

test('integration DB preparation requires all disposable schemas to be empty before provisioning',()=>{
  assert.match(prepare,/for db in "\$DB_NAME" "\$RESTORE_DB" "\$PREFLIGHT_DB" "\$DRAW_GUARD_DB"; do[\s\S]*?Fixture database \$db is not empty/);
  assert.match(prepare,/CREATE DATABASE IF NOT EXISTS/);
  assert.doesNotMatch(prepare,/DROP DATABASE|DROP SCHEMA/);
});

test('integration DB preparation provisions separate least-privilege runtime, migration, backup and restore identities',()=>{
  for(const value of [
    "CREATE USER '$TEST_USER'@'127.0.0.1'",
    "CREATE USER '$MIGRATION_USER'@'127.0.0.1'",
    "CREATE USER '$BACKUP_USER'@'127.0.0.1'",
    "CREATE USER '$RESTORE_USER'@'127.0.0.1'",
    "CREATE USER '$RESTORE_RUNTIME_USER'@'127.0.0.1'",
    'GRANT SELECT, INSERT, UPDATE, DELETE ON',
    'GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, TRIGGER ON',
    'GRANT SELECT, SHOW VIEW, TRIGGER ON',
    'GRANT TRIGGER ON',
    'GRANT SET_USER_ID ON *.*',
    'GRANT SELECT, INSERT, UPDATE, DELETE ON'
  ]) assert.ok(prepare.includes(value),'missing integration identity/grant setup: '+value);
  assert.match(prepare,/Integration identities must never reuse a production runtime or migration identity/);
  assert.match(prepare,/All integration MySQL identities must be distinct/);
  assert.match(prepare,/already exists at one or more hosts; refusing to alter or reuse it/);
});

test('integration runner requires and exports every identity used by MySQL backup/restore tests',()=>{
  for(const name of [
    'MYSQL_MIGRATION_USER','MYSQL_MIGRATION_PASSWORD',
    'MYSQL_BACKUP_USER','MYSQL_BACKUP_PASSWORD',
    'MYSQL_RESTORE_USER','MYSQL_RESTORE_PASSWORD',
    'MYSQL_RESTORE_RUNTIME_USER','MYSQL_RESTORE_RUNTIME_PASSWORD',
    'MYSQL_TEST_ADMIN_USER','MYSQL_TEST_ADMIN_PASSWORD',
    'MYSQL_TEST_READONLY_USER','MYSQL_TEST_READONLY_PASSWORD',
    'DRAW_SEED_ENCRYPTION_KEY'
  ]) {
    assert.ok(runner.includes(name),'runner is missing required integration setting '+name);
  }
  assert.match(runner,/Integration tests are restricted to loopback MySQL/);
  assert.match(runner,/Production runtime and migration identities are not used/);
  assert.match(runner,/unset MYSQL_PRIVILEGE_TEST_DATABASE/);
});
