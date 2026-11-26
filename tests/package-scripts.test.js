import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const packageJson=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));

test('integration test script uses the safety runner',()=>{
  const script=String(packageJson.scripts?.['test:integration']||'');
  assert.match(script,/run-integration-tests\.sh/);
  const runner=readFileSync(new URL('../scripts/run-integration-tests.sh',import.meta.url),'utf8');
  for(const token of ['MYSQL_TEST_DATABASE','MYSQL_RESTORE_DATABASE','MYSQL_PREFLIGHT_DATABASE','MYSQL_DRAW_GUARD_DATABASE','MYSQL_DATABASE','dotenv.parse','read_dotenv_value','ALLOW_DATABASE_MIGRATIONS=1','ALLOW_TEST_DATABASE_MIGRATIONS=1','RUN_MYSQL_TESTS=1','loopback MySQL','Refusing to run tests against a production database.'])assert.ok(runner.includes(token),'Missing runner safety token: '+token);
  assert.doesNotMatch(runner,/ALLOW_PRODUCTION_MIGRATIONS=1/);
});

test('integration runner refuses application database and remote MySQL before requiring credentials',()=>{
  const runner=new URL('../scripts/run-integration-tests.sh',import.meta.url);
  const base={...process.env,MYSQL_TEST_DATABASE:'isolated_ci',MYSQL_RESTORE_DATABASE:'draw_restore_fixture_ci',MYSQL_PREFLIGHT_DATABASE:'ustore_preflight_fixture_ci',MYSQL_DRAW_GUARD_DATABASE:'ustore_drawguard_fixture_ci',MYSQL_USER:'ustore_app_fixture'};
  const equalDb=spawnSync('bash',[runner.pathname],{encoding:'utf8',env:{...base,MYSQL_DATABASE:'isolated_ci',MYSQL_HOST:'127.0.0.1'}});
  assert.notEqual(equalDb.status,0);
  assert.match(equalDb.stderr,/Refusing to run tests against a production database/);
  const remote=spawnSync('bash',[runner.pathname],{encoding:'utf8',env:{...base,MYSQL_DATABASE:'production',MYSQL_HOST:'203.0.113.10'}});
  assert.notEqual(remote.status,0);
  assert.match(remote.stderr,/restricted to loopback MySQL/);
});
