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
