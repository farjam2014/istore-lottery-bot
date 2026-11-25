import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../../src/bot/handlers/user.handler.js',import.meta.url),'utf8');

test('participant support sessions expire after 24 hours before consuming text',()=>{
  assert.match(source,/support_sessions WHERE telegram_user_id=\? AND updated_at>=DATE_SUB\(UTC_TIMESTAMP\(\),INTERVAL 24 HOUR\)/);
  assert.match(source,/DELETE FROM support_sessions WHERE telegram_user_id=\? AND updated_at<DATE_SUB\(UTC_TIMESTAMP\(\),INTERVAL 24 HOUR\)/);
  assert.match(source,/support_sessions WHERE telegram_user_id=\? AND updated_at>=DATE_SUB\(UTC_TIMESTAMP\(\),INTERVAL 24 HOUR\) FOR UPDATE/);
});

test('reopening a participant support request or reply refreshes its TTL',()=>{
  assert.match(source,/category=VALUES\(category\),updated_at=CURRENT_TIMESTAMP/);
  assert.match(source,/category=NULL,updated_at=CURRENT_TIMESTAMP/);
});
