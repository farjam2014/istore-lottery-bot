import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const packageJson=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));

test('integration test script uses the safety runner',()=>{
  const script=String(packageJson.scripts?.['test:integration']||'');
  assert.match(script,/run-integration-tests\.sh/);
  const runner=readFileSync(new URL('../scripts/run-integration-tests.sh',import.meta.url),'utf8');
  assert.ok(runner.includes('MYSQL_TEST_DATABASE'));
  assert.ok(runner.includes('_ci
  assert.ok(runner.includes('MYSQL_DATABASE'));
  assert.ok(runner.includes('dotenv/config'));
  assert.ok(runner.includes('read_dotenv_value'));
  assert.ok(runner.includes('ALLOW_DATABASE_MIGRATIONS=1'));
  assert.ok(runner.includes('ALLOW_TEST_DATABASE_MIGRATIONS=1'));
  assert.ok(runner.includes('RUN_MYSQL_TESTS=1'));
  assert.ok(runner.includes('loopback MySQL'));
  assert.ok(runner.includes('Refusing to run tests against a production database.'));
  assert.doesNotMatch(runner,/ALLOW_PRODUCTION_MIGRATIONS=1/);
});

test('integration runner refuses application database and remote MySQL',()=>{
  const runner=new URL('../scripts/run-integration-tests.sh',import.meta.url);
  const equalDb=spawnSync('bash',[runner.pathname],{encoding:'utf8',env:{...process.env,MYSQL_TEST_DATABASE:'production_ci',MYSQL_RESTORE_DATABASE:'draw_restore_ci',MYSQL_PREFLIGHT_DATABASE:'ustore_preflight_ci',MYSQL_DRAW_GUARD_DATABASE:'ustore_drawguard_ci',MYSQL_DATABASE:'production_ci',MYSQL_HOST:'127.0.0.1'}});
  assert.notEqual(equalDb.status,0);
  assert.match(equalDb.stderr,/Refusing to run tests against a production database/);
  const remote=spawnSync('bash',[runner.pathname],{encoding:'utf8',env:{...process.env,MYSQL_TEST_DATABASE:'isolated_ci',MYSQL_RESTORE_DATABASE:'draw_restore_ci',MYSQL_PREFLIGHT_DATABASE:'ustore_preflight_ci',MYSQL_DRAW_GUARD_DATABASE:'ustore_drawguard_ci',MYSQL_DATABASE:'production',MYSQL_HOST:'203.0.113.10'}});
  assert.notEqual(remote.status,0);
  assert.match(remote.stderr,/restricted to loopback MySQL/);
});
));
  assert.ok(runner.includes('MYSQL_DATABASE'));
  assert.ok(runner.includes('dotenv/config'));
  assert.ok(runner.includes('read_dotenv_value'));
  assert.ok(runner.includes('ALLOW_DATABASE_MIGRATIONS=1'));
  assert.ok(runner.includes('ALLOW_TEST_DATABASE_MIGRATIONS=1'));
  assert.ok(runner.includes('RUN_MYSQL_TESTS=1'));
  assert.ok(runner.includes('loopback MySQL'));
  assert.ok(runner.includes('Refusing to run integration tests against MYSQL_DATABASE'));
  assert.doesNotMatch(runner,/ALLOW_PRODUCTION_MIGRATIONS=1/);
});

test('integration runner refuses application database and remote MySQL',()=>{
  const runner=new URL('../scripts/run-integration-tests.sh',import.meta.url);
  const equalDb=spawnSync('bash',[runner.pathname],{encoding:'utf8',env:{...process.env,MYSQL_TEST_DATABASE:'production_ci',MYSQL_DATABASE:'production_ci',MYSQL_HOST:'127.0.0.1'}});
  assert.notEqual(equalDb.status,0);
  assert.match(equalDb.stderr,/Refusing to run integration tests against MYSQL_DATABASE/);
  const remote=spawnSync('bash',[runner.pathname],{encoding:'utf8',env:{...process.env,MYSQL_TEST_DATABASE:'isolated_ci',MYSQL_DATABASE:'production',MYSQL_HOST:'203.0.113.10'}});
  assert.notEqual(remote.status,0);
  assert.match(remote.stderr,/restricted to loopback MySQL/);
});
