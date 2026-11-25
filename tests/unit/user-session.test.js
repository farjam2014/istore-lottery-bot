import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../../src/bot/handlers/user.handler.js',import.meta.url),'utf8');

test('starting a profile change clears any active support text session',()=>{
  const start=source.indexOf("bot.action(/^user:profile:field:");
  const end=source.indexOf("\n",start);
  assert.ok(start>=0);
  assert.match(source.slice(start,end),/DELETE FROM support_sessions WHERE telegram_user_id=\?/);
});

test('starting a support ticket clears any active profile change session',()=>{
  const start=source.indexOf("bot.action(/^support:user:category:");
  const end=source.indexOf("\n",start);
  assert.ok(start>=0);
  assert.match(source.slice(start,end),/DELETE FROM profile_change_sessions WHERE telegram_user_id=\?/);
});

test('starting a support reply clears any active profile change session',()=>{
  const start=source.indexOf("bot.action(/^support:user:reply:");
  const end=source.indexOf("\n",start);
  assert.ok(start>=0);
  assert.match(source.slice(start,end),/DELETE FROM profile_change_sessions WHERE telegram_user_id=\?/);
});

test('support text sessions enforce a 24-hour TTL and recheck it under row lock',()=>{
  assert.match(source,/support_sessions WHERE telegram_user_id=\? AND updated_at>=DATE_SUB\(UTC_TIMESTAMP\(\),INTERVAL 24 HOUR\)/);
  assert.match(source,/support_sessions WHERE telegram_user_id=\? AND updated_at>=DATE_SUB\(UTC_TIMESTAMP\(\),INTERVAL 24 HOUR\) FOR UPDATE/);
});

test('invalid support reply does not destroy an active profile-change session',()=>{
  const start=source.indexOf("bot.action(/^support:user:reply:");
  const end=source.indexOf("\n",start);
  assert.ok(start>=0);
  const handler=source.slice(start,end);
  assert.ok(handler.indexOf("SELECT t.id FROM support_tickets")<handler.indexOf("DELETE FROM profile_change_sessions"));
});

test('sensitive admin reads are recorded in the append-oriented audit stream',()=>{
  const admin=readFileSync(new URL('../../src/bot/handlers/admin.handler.js',import.meta.url),'utf8');
  assert.match(admin,/audit\(ctx\.from\.id,'participant\.viewed','participant',id\)/);
  assert.match(admin,/audit\(ctx\.from\.id,'profile_change_request\.viewed','profile_change_request',id\)/);
  assert.match(admin,/audit\(ctx\.from\.id,'support_ticket\.viewed','support_ticket',id\)/);
});

test('participant support and profile sessions bind the creating Telegram update ID',()=>{
  const profileStart=source.slice(source.indexOf("bot.action(/^user:profile:field:"),source.indexOf("\\n",source.indexOf("bot.action(/^user:profile:field:")));
  const supportStart=source.slice(source.indexOf("bot.action(/^support:user:category:"),source.indexOf("\\n",source.indexOf("bot.action(/^support:user:category:")));
  const supportReplyStart=source.slice(source.indexOf("bot.action(/^support:user:reply:"),source.indexOf("\\n",source.indexOf("bot.action(/^support:user:reply:")));
  assert.match(profileStart,/profile_change_sessions\\(telegram_user_id,step,last_update_id\\) VALUES\\(\\?,\\?,\\?\\)/);
  assert.match(profileStart,/ctx\\.update\\.update_id/);
  assert.match(supportStart,/support_sessions\\(telegram_user_id,step,category,last_update_id\\)/);
  assert.match(supportStart,/ctx\\.update\\.update_id/);
  assert.match(supportReplyStart,/support_sessions\\(telegram_user_id,step,ticket_id,last_update_id\\)/);
  assert.match(supportReplyStart,/ctx\\.update\\.update_id/);
});

test('participant support and profile message handlers reject stale update IDs before consuming sessions',()=>{
  assert.match(source,/SELECT step,last_update_id FROM profile_change_sessions/);
  assert.match(source,/SELECT step,ticket_id,category,updated_at,last_update_id FROM support_sessions/);
  assert.match(source,/isStaleTelegramUpdate\\(ctx\\.update\\?\\.update_id,profileSession\\.last_update_id\\)/);
  assert.match(source,/isStaleTelegramUpdate\\(ctx\\.update\\?\\.update_id,session\\.last_update_id\\)/);
  assert.match(source,/SELECT step,ticket_id,category,updated_at,last_update_id FROM support_sessions WHERE telegram_user_id=\\? AND updated_at>=DATE_SUB\\(UTC_TIMESTAMP\\(\\),INTERVAL 24 HOUR\\) FOR UPDATE/);
  assert.match(source,/SELECT step,last_update_id FROM profile_change_sessions WHERE telegram_user_id=\\? AND step=\\? AND created_at>=DATE_SUB\\(UTC_TIMESTAMP\\(\\),INTERVAL 24 HOUR\\) FOR UPDATE/);
});

test('participant session replay migration clears legacy sessions that have no cursor',()=>{
  const migration=readFileSync(new URL('../../src/database/migrations/20261125_003_participant_session_replay.sql',import.meta.url),'utf8');
  assert.match(migration,/DELETE FROM support_sessions WHERE last_update_id IS NULL/);
  assert.match(migration,/ADD COLUMN last_update_id BIGINT NULL/);
  assert.match(migration,/DELETE FROM profile_change_sessions/);
});
