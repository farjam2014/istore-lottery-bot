import test from 'node:test';
import assert from 'node:assert/strict';
import {clearAdminTextSessions} from '../../src/modules/admin/admin-text-sessions.js';

function executor(){const calls=[];return {calls,async execute(sql,params){calls.push({sql,params});return [{affectedRows:1},[]];}};}

test('starting an admin wizard clears competing text sessions but preserves its own state',async()=>{
  const db=executor();
  await clearAdminTextSessions({telegramUserId:'12345',keep:'admin_wizards',executor:db});
  assert.equal(db.calls.length,5);
  assert.ok(db.calls.every(call=>call.params[0]==='12345'));
  assert.ok(db.calls.some(call=>call.sql.includes('payment_card_admin_sessions')));
  assert.ok(db.calls.some(call=>call.sql.includes('payment_admin_sessions')));
  assert.ok(db.calls.some(call=>call.sql.includes('admin_search_sessions')));
  assert.ok(db.calls.some(call=>call.sql.includes('admin_role_sessions')));
  assert.ok(db.calls.some(call=>call.sql.includes('support_sessions')));
  assert.ok(db.calls.every(call=>!call.sql.includes('DELETE FROM admin_wizards')));
});

test('starting support reply clears all other admin text sessions',async()=>{
  const db=executor();
  await clearAdminTextSessions({telegramUserId:'67890',keep:'support_sessions',executor:db});
  assert.equal(db.calls.length,5);
  assert.ok(db.calls.every(call=>!call.sql.includes('DELETE FROM support_sessions')));
  assert.ok(db.calls.every(call=>call.params[0]==='67890'));
});

test('unknown session types and empty Telegram IDs are rejected',async()=>{
  const db=executor();
  await assert.rejects(clearAdminTextSessions({telegramUserId:'12345',keep:'unknown',executor:db}),/Unknown admin text session type/);
  await assert.rejects(clearAdminTextSessions({telegramUserId:'',keep:'admin_wizards',executor:db}),/Telegram user ID is required/);
  assert.equal(db.calls.length,0);
});
