import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const path=fileURLToPath(new URL('../../src/database/migrate.js',import.meta.url));
const source=await readFile(path,'utf8');

test('migration runner records whether GET_LOCK returned before connection cleanup',()=>{
  assert.match(source,/let lockAcquisitionResolved=false/);
  assert.match(source,/lockAcquisitionResolved=true/);
  assert.match(source,/releaseMigrationConnection\(c,\{lockName:LOCK_NAME,lockAcquisitionResolved,lockAcquired\}\)/);
});
