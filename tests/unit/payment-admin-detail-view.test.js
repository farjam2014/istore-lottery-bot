import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const source=readFileSync(fileURLToPath(new URL('../../src/bot/handlers/admin.handler.js',import.meta.url)),'utf8');
const start=source.indexOf('async function showManagedOrderDetail');
const end=source.indexOf('\n}',start);
const handler=source.slice(start,end);

test('finance order detail shows the participant phone but not Telegram or Instagram identifiers',()=>{
  assert.ok(start>=0,'order detail renderer must exist');
  assert.match(handler,/o\.phone/);
  assert.doesNotMatch(handler,/o\.(?:telegram_user_id|instagram_handle|telegram_username)/);
});
