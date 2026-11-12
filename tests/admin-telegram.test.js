'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdminTelegram } = require('../src/admin-telegram');

function harness() {
  const calls = [];
  const conn = {
    async beginTransaction() { calls.push({ sql: 'BEGIN' }); },
    async commit() { calls.push({ sql: 'COMMIT' }); },
    async rollback() { calls.push({ sql: 'ROLLBACK' }); },
    release() { calls.push({ sql: 'RELEASE' }); },
    async execute(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT id,status,raffle_code FROM lottery_entries')) return [[{ id: 42, status: 'active', raffle_code: 'LOT-ABCDEFGH' }]];
      if (sql.includes('SELECT id,full_name,phone,instagram,status FROM lottery_entries')) return [[{ id: 42, full_name: 'Ali Rezaei', phone: '09120000000', instagram: 'ali.old', status: 'active' }]];
      if (sql.includes('SELECT id FROM lottery_entries WHERE status=\\'active\\'')) return [[]];
      return [{ affectedRows: 1, insertId: 77 }];
    },
    async query() { return [[]]; }
  };
  const db = {
    async execute(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT id,full_name,phone,instagram,status FROM lottery_entries')) return [[{ id: 42, full_name: 'Ali Rezaei', phone: '09120000000', instagram: 'ali.old', status: 'active' }]];
      if (sql.includes('SELECT id,status FROM lottery_entries')) return [[{ id: 42, status: 'active' }]];
      if (sql.includes('SELECT id,full_name,phone,instagram,raffle_code,status,created_at,updated_at,deletion_reason')) return [[{ id: 42, full_name: 'Ali Rezaei', phone: '09121111111', instagram: 'ali.new', raffle_code: 'LOT-ABCDEFGH', status: 'active', created_at: 'now' }]];
      if (sql.includes('SELECT raffle_code,action,actor,created_at FROM lottery_code_history')) return [[]];
      return [{ affectedRows: 1 }];
    },
    async query() { return [[]]; },
    async getConnection() { return conn; }
  };
  const telegram = [];
  const tg = async (method, payload) => { telegram.push({ method, payload }); return { ok: true }; };
  const admin = createAdminTelegram({
    db, tg, tgDocument: async () => ({ ok: true }),
    adminId: '12345', registrationOpen: async () => false
  });
  return { admin, calls, telegram };
}

test('admin edit preview can be cancelled with /cancel', async () => {
  const h = harness();
  const callback = {
    id: 'cb1', data: 'adm:edit:42',
    from: { id: 12345 },
    message: { chat: { id: 12345, type: 'private' } }
  };
  assert.notEqual(await h.admin.handleCallback(callback), false);
  assert.notEqual(await h.admin.handleMessage({
    from: { id: 12345 }, chat: { id: 12345, type: 'private' },
    text: 'Ali Rezaei | 09121111111 | ali.new'
  }), false);
  assert.ok(h.telegram.some(x => String(x.payload.text || '').includes('پیش‌نمایش ویرایش')));
  assert.notEqual(await h.admin.handleMessage({
    from: { id: 12345 }, chat: { id: 12345, type: 'private' }, text: '/cancel'
  }), false);
  assert.ok(h.telegram.some(x => String(x.payload.text || '').includes('عملیات لغو شد')));
  assert.equal(h.calls.some(x => x.sql.startsWith('UPDATE lottery_entries SET full_name=')), false);
});

test('admin edit rejects malformed and invalid participant data', async () => {
  const h = harness();
  await h.admin.handleCallback({
    id: 'cb2', data: 'adm:edit:42', from: { id: 12345 },
    message: { chat: { id: 12345, type: 'private' } }
  });
  await h.admin.handleMessage({
    from: { id: 12345 }, chat: { id: 12345, type: 'private' },
    text: 'A | not-a-phone | bad handle'
  });
  assert.ok(h.telegram.some(x => String(x.payload.text || '').includes('اطلاعات نامعتبر')));
  assert.equal(h.calls.some(x => x.sql.startsWith('UPDATE lottery_entries SET full_name=')), false);
});


test('admin edit commits participant changes and audit record together', async () => {
  const h = harness();
  const message = { from: { id: 12345 }, chat: { id: 12345, type: 'private' } };
  await h.admin.handleCallback({ id: 'cb3', data: 'adm:edit:42', ...message });
  await h.admin.handleMessage({ ...message, text: 'Ali Rezaei | 09121111111 | ali.new' });
  await h.admin.handleCallback({ id: 'cb4', data: 'adm:apply-edit:42', ...message });
  const updateIndex = h.calls.findIndex(x => x.sql.startsWith('UPDATE lottery_entries SET full_name='));
  const auditIndex = h.calls.findIndex(x => x.sql.includes('INSERT INTO admin_audit_log'));
  const commitIndex = h.calls.findIndex(x => x.sql === 'COMMIT');
  assert.ok(updateIndex >= 0);
  assert.ok(auditIndex > updateIndex);
  assert.ok(commitIndex > auditIndex);
  assert.equal(h.calls.some(x => x.sql === 'ROLLBACK'), false);
});

test('admin delete requires confirmation and writes soft-delete plus audit atomically', async () => {
  const h = harness();
  const message = { from: { id: 12345 }, chat: { id: 12345, type: 'private' } };
  await h.admin.handleCallback({ id: 'cb5', data: 'adm:delete:42', ...message });
  assert.equal(h.calls.some(x => x.sql.includes("status='deleted'")), false);
  await h.admin.handleCallback({ id: 'cb6', data: 'adm:apply-delete:42', ...message });
  const updateIndex = h.calls.findIndex(x => x.sql.includes("UPDATE lottery_entries SET status='deleted'"));
  const auditIndex = h.calls.findIndex(x => x.sql.includes('INSERT INTO admin_audit_log'));
  const commitIndex = h.calls.findIndex(x => x.sql === 'COMMIT');
  assert.ok(updateIndex >= 0);
  assert.ok(auditIndex > updateIndex);
  assert.ok(commitIndex > auditIndex);
  assert.equal(h.calls.some(x => x.sql === 'ROLLBACK'), false);
});
