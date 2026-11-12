'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdminTelegram } = require('../src/admin-telegram');

function harness() {
  const calls = [];
  const db = {
    async execute(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT id,full_name,phone,instagram,status FROM lottery_entries')) {
        return [[{ id: 42, full_name: 'Ali Rezaei', phone: '09120000000', instagram: 'ali.old', status: 'active' }]];
      }
      if (sql.includes('SELECT id,status FROM lottery_entries')) return [[{ id: 42, status: 'active' }]];
      return [{ affectedRows: 1 }];
    },
    async query() { return [[]]; }
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
