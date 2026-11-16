import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const path=fileURLToPath(new URL('../../src/database/migrate.js',import.meta.url));
const source=await readFile(path,'utf8');

test('migration runner verifies advisory lock release and never pools a connection that may still hold the lock',()=>{
  assert.match(source,/GET_LOCK\(\?, 30\)/);
  assert.match(source,/RELEASE_LOCK\(\?\) AS released/);
  assert.match(source,/Number\(released\?\.released\)!==1\)reusable=false/);
  assert.match(source,/catch\{reusable=false;\}/);
  assert.match(source,/if\(reusable\)c\.release\(\);else c\.destroy\(\)/);
});
