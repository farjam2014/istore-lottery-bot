import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const packageJson=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));

test('integration test script authorizes only disposable test migrations',()=>{
  const script=String(packageJson.scripts?.['test:integration']||'');
  assert.match(script,/NODE_ENV=test/);
  assert.match(script,/ALLOW_DATABASE_MIGRATIONS=1/);
  assert.match(script,/ALLOW_TEST_DATABASE_MIGRATIONS=1/);
  assert.match(script,/RUN_MYSQL_TESTS=1/);
  assert.doesNotMatch(script,/ALLOW_PRODUCTION_MIGRATIONS=1/);
});
