import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const packageJson=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));

test('integration test script authorizes only disposable test migrations',()=>{
  const script=String(packageJson.scripts?.['test:integration']||'');
  assert.match(script,/run-integration-tests\.sh/);
  const runner=readFileSync(new URL('../scripts/run-integration-tests.sh',import.meta.url),'utf8');
  assert.match(runner,/MYSQL_TEST_DATABASE/);
  assert.ok(runner.includes('_(ci|test)
  assert.match(runner,/MYSQL_DATABASE/);
  assert.match(runner,/dotenv\/config/);
  assert.match(runner,/read_dotenv_value/);
  assert.match(runner,/ALLOW_DATABASE_MIGRATIONS=1/);
  assert.match(runner,/ALLOW_TEST_DATABASE_MIGRATIONS=1/);
  assert.match(runner,/RUN_MYSQL_TESTS=1/);
  assert.match(runner,/loopback MySQL/);
  assert.doesNotMatch(runner,/ALLOW_PRODUCTION_MIGRATIONS=1/);
});
));
  assert.match(runner,/MYSQL_DATABASE/);
  assert.match(runner,/dotenv\/config/);
  assert.match(runner,/read_dotenv_value/);
  assert.match(runner,/ALLOW_DATABASE_MIGRATIONS=1/);
  assert.match(runner,/ALLOW_TEST_DATABASE_MIGRATIONS=1/);
  assert.match(runner,/RUN_MYSQL_TESTS=1/);
  assert.match(runner,/loopback MySQL/);
  assert.doesNotMatch(runner,/ALLOW_PRODUCTION_MIGRATIONS=1/);
});

test('integration runner refuses the application database and remote MySQL',()=>{
  const runner=new URL('../scripts/run-integration-tests.sh',import.meta.url);
  const equalDb=spawnSync('bash',[runner.pathname],{encoding:'utf8',env:{...process.env,MYSQL_TEST_DATABASE:'production_ci',MYSQL_DATABASE:'production_ci',MYSQL_HOST:'127.0.0.1'}});
  assert.notEqual(equalDb.status,0);
  assert.match(equalDb.stderr,/Refusing to run integration tests against MYSQL_DATABASE/);
  const remote=spawnSync('bash',[runner.pathname],{encoding:'utf8',env:{...process.env,MYSQL_TEST_DATABASE:'isolated_ci',MYSQL_DATABASE:'production',MYSQL_HOST:'203.0.113.10'}});
  assert.notEqual(remote.status,0);
  assert.match(remote.stderr,/restricted to loopback MySQL/);
});
