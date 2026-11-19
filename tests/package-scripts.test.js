import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const packageJson=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));

test('integration test script authorizes only disposable test migrations',()=>{
  const script=String(packageJson.scripts?.['test:integration']||'');
  assert.match(script,/run-integration-tests\\.sh/);
  const runner=readFileSync(new URL('../scripts/run-integration-tests.sh',import.meta.url),'utf8');
  assert.match(runner,/MYSQL_TEST_DATABASE/);
  assert.match(runner,/_\\(ci\\|test\\)\\$/);
  assert.match(runner,/MYSQL_DATABASE/);
  assert.match(runner,/ALLOW_DATABASE_MIGRATIONS=1/);
  assert.match(runner,/ALLOW_TEST_DATABASE_MIGRATIONS=1/);
  assert.match(runner,/RUN_MYSQL_TESTS=1/);
  assert.match(runner,/loopback MySQL/);
  assert.doesNotMatch(runner,/ALLOW_PRODUCTION_MIGRATIONS=1/);
});
