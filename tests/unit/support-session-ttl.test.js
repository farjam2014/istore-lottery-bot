import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isStaleTelegramUpdate} from '../../src/shared/telegram-update-cursor.js';

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

test('profile change sessions expire after 24 hours and are revalidated under lock',()=>{
  assert.match(source,/profile_change_sessions WHERE telegram_user_id=\? AND created_at>=DATE_SUB\(UTC_TIMESTAMP\(\),INTERVAL 24 HOUR\)/);
  assert.match(source,/profile_change_sessions WHERE telegram_user_id=\? AND created_at<DATE_SUB\(UTC_TIMESTAMP\(\),INTERVAL 24 HOUR\)/);
  assert.match(source,/created_at=CURRENT_TIMESTAMP/);
  assert.match(source,/profile_change_sessions WHERE telegram_user_id=\? AND step=\? AND created_at>=DATE_SUB\(UTC_TIMESTAMP\(\),INTERVAL 24 HOUR\) FOR UPDATE/);
});


test('participant support and profile sessions persist their starting Telegram update cursor',()=>{
  assert.match(source,/support_sessions\(telegram_user_id,step,category,last_update_id\) VALUES\(\?,'new_message',\?,\?\)/);
  assert.match(source,/support_sessions\(telegram_user_id,step,ticket_id,last_update_id\) VALUES\(\?,'user_reply',\?,\?\)/);
  assert.match(source,/profile_change_sessions\(telegram_user_id,step,last_update_id\) VALUES\(\?,\?,\?\)/);
});

test('delayed participant text and contact updates are rejected against the session cursor',()=>{
  assert.match(source,/SELECT step,last_update_id FROM profile_change_sessions/);
  assert.match(source,/SELECT step,ticket_id,category,updated_at,last_update_id FROM support_sessions/);
  assert.match(source,/isStaleTelegramUpdate\(ctx\.update\?\.update_id,profileSession\.last_update_id\)/);
  assert.match(source,/isStaleTelegramUpdate\(ctx\.update\?\.update_id,session\.last_update_id\)/);
});

test('participant support handlers recheck the replay cursor after acquiring the row lock',()=>{
  assert.match(source,/SELECT step,ticket_id,category,updated_at,last_update_id FROM support_sessions[\s\S]*?FOR UPDATE/);
  assert.match(source,/SELECT step,ticket_id,updated_at,last_update_id FROM support_sessions[\s\S]*?FOR UPDATE/);
  assert.match(source,/isStaleTelegramUpdate\(ctx\.update\?\.update_id,lockedSession\.last_update_id\)/);
});

test('profile-change request transaction rechecks its cursor under the session row lock',()=>{
  assert.match(source,/SELECT step,last_update_id FROM profile_change_sessions[\s\S]*?FOR UPDATE/);
  assert.match(source,/isStaleTelegramUpdate\(updateId,session\.last_update_id\)/);
});


test('Telegram session cursors reject stale, duplicate, missing, and unsafe update IDs',()=>{
  assert.equal(isStaleTelegramUpdate(100,101),true,'an update older than the session start is stale');
  assert.equal(isStaleTelegramUpdate(101,101),true,'the session-start callback cannot be reused as input');
  assert.equal(isStaleTelegramUpdate(102,101),false,'a later update may advance the session');
  assert.equal(isStaleTelegramUpdate(102,null),true,'pre-cursor sessions fail closed');
  assert.equal(isStaleTelegramUpdate(Number.MAX_SAFE_INTEGER+1,101),true,'unsafe numeric IDs fail closed');
  assert.equal(isStaleTelegramUpdate(undefined,101),true,'missing update IDs fail closed');
});
