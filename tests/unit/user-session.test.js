import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../../src/bot/handlers/user.handler.js',import.meta.url),'utf8');

test('starting a profile change uses a participant-locked transaction and clears only user support sessions',()=>{
  const start=source.indexOf('export async function startProfileChangeSession');
  const end=source.indexOf('export async function startUserSupportSession',start);
  assert.ok(start>=0&&end>start);
  const helper=source.slice(start,end);
  assert.match(helper,/withParticipantSessionLock/);
  assert.match(helper,/SELECT id FROM participants WHERE telegram_user_id=\\? FOR UPDATE/);
  assert.match(helper,/DELETE FROM support_sessions WHERE telegram_user_id=\\? AND step IN \\('new_message','user_reply'\\)/);
  assert.match(helper,/created_at=CURRENT_TIMESTAMP/);
  assert.match(source,/startProfileChangeSession\\(\\{telegramUserId:ctx\\.from\\.id,step:field,updateId\\}\\)/);
});

test('starting a support ticket or reply uses the same participant lock and refreshes session TTL',()=>{
  const start=source.indexOf('export async function startUserSupportSession');
  const end=source.indexOf('export async function cancelProfileChangeSession',start);
  assert.ok(start>=0&&end>start);
  const helper=source.slice(start,end);
  assert.match(helper,/withParticipantSessionLock/);
  assert.match(helper,/DELETE FROM profile_change_sessions WHERE telegram_user_id=\\?/);
  assert.match(helper,/updated_at=UTC_TIMESTAMP\\(\\)/);
  assert.match(helper,/currentSupport\\?\\.step==='admin_reply'/);
  assert.match(source,/startUserSupportSession\\(\\{telegramUserId:ctx\\.from\\.id,step:'new_message',category:ctx\\.match\\[1\\],updateId\\}\\)/);
  assert.match(source,/startUserSupportSession\\(\\{telegramUserId:ctx\\.from\\.id,step:'user_reply',ticketId:id,updateId\\}\\)/);
});

test('participant cancel actions are cursor-bound and cannot delete a newer session',()=>{
  assert.match(source,/user:profile:cancel:\\(\\\\d\\+\\)/);
  assert.match(source,/support:user:cancel:\\(\\\\d\\+\\)/);
  assert.match(source,/DELETE FROM profile_change_sessions WHERE telegram_user_id=\\? AND last_update_id=\\?/);
  assert.match(source,/DELETE FROM support_sessions WHERE telegram_user_id=\\? AND step IN \\('new_message','user_reply'\\) AND last_update_id=\\?/);
  assert.match(source,/expectedUpdateId:Number\\(ctx\\.match\\[1\\]\\)/);
});

test('profile and support message transactions lock the participant before locking the active session',()=>{
  const profile=source.slice(source.indexOf('async function createProfileChangeRequest'),source.indexOf('\\n}',source.indexOf('async function createProfileChangeRequest')));
  assert.ok(profile.indexOf('SELECT id FROM participants')<profile.indexOf('SELECT step,last_update_id FROM profile_change_sessions'));
  const support=source.slice(source.indexOf("if(session.step==='new_message')"),source.indexOf("return next();});",source.indexOf("if(session.step==='new_message')")));
  assert.ok(support.indexOf('SELECT id FROM participants')<support.indexOf('SELECT step,ticket_id,category,updated_at,last_update_id FROM support_sessions'));
  assert.ok(support.indexOf('SELECT id,status,ticket_number FROM support_tickets')<0||support.indexOf('SELECT id,status,ticket_number FROM support_tickets')>support.indexOf('SELECT id FROM participants'));
});

test('support text consumption rechecks the cursor under lock and deletes only the consumed session version',()=>{
  assert.match(source,/SELECT step,ticket_id,category,updated_at,last_update_id FROM support_sessions WHERE telegram_user_id=\\? AND updated_at>=DATE_SUB\\(UTC_TIMESTAMP\\(\\),INTERVAL 24 HOUR\\) FOR UPDATE/);
  assert.match(source,/isStaleTelegramUpdate\\(ctx\\.update\\?\\.update_id,lockedSession\\.last_update_id\\)/);
  assert.match(source,/DELETE FROM support_sessions WHERE telegram_user_id=\\? AND step='new_message' AND last_update_id=\\?/);
  assert.match(source,/DELETE FROM support_sessions WHERE telegram_user_id=\\? AND step='user_reply' AND last_update_id=\\?/);
});

test('invalid support reply does not destroy an active profile-change session before ticket ownership is checked',()=>{
  const start=source.indexOf("bot.action(/^support:user:reply:");
  const end=source.indexOf("\\n",start);
  assert.ok(start>=0);
  const handler=source.slice(start,end);
  assert.ok(handler.indexOf("SELECT t.id FROM support_tickets")<handler.indexOf("startUserSupportSession"));
});

test('sensitive admin reads are recorded in the append-oriented audit stream',()=>{
  const admin=readFileSync(new URL('../../src/bot/handlers/admin.handler.js',import.meta.url),'utf8');
  assert.match(admin,/audit\\(ctx\\.from\\.id,'participant\\.viewed','participant',id\\)/);
  assert.match(admin,/audit\\(ctx\\.from\\.id,'profile_change_request\\.viewed','profile_change_request',id\\)/);
  assert.match(admin,/audit\\(ctx\\.from\\.id,'support_ticket\\.viewed','support_ticket',id\\)/);
});

test('participant support and profile sessions reject stale update IDs before consuming sessions',()=>{
  assert.match(source,/SELECT step,last_update_id FROM profile_change_sessions/);
  assert.match(source,/SELECT step,ticket_id,category,updated_at,last_update_id FROM support_sessions/);
  assert.match(source,/isStaleTelegramUpdate\\(ctx\\.update\\?\\.update_id,profileSession\\.last_update_id\\)/);
  assert.match(source,/isStaleTelegramUpdate\\(ctx\\.update\\?\\.update_id,session\\.last_update_id\\)/);
  assert.match(source,/SELECT step,last_update_id FROM profile_change_sessions WHERE telegram_user_id=\\? AND step=\\? AND created_at>=DATE_SUB\\(UTC_TIMESTAMP\\(\\),INTERVAL 24 HOUR\\) FOR UPDATE/);
});

test('participant session replay migration clears legacy sessions that have no cursor',()=>{
  const migration=readFileSync(new URL('../../src/database/migrations/20261125_003_participant_session_replay.sql',import.meta.url),'utf8');
  assert.match(migration,/DELETE FROM support_sessions WHERE last_update_id IS NULL/);
  assert.match(migration,/ADD COLUMN last_update_id BIGINT NULL/);
  assert.match(migration,/DELETE FROM profile_change_sessions/);
});
