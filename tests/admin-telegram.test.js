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
      if (sql.includes("SELECT id FROM lottery_entries WHERE status='active'")) return [[]];
      return [{ affectedRows: 1, insertId: 77 }];
    },
    async query() { return [[]]; }
  };
  const db = {
    async execute(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM campaigns c') || sql.includes('FROM payment_orders o JOIN campaigns')) return [[]];
      if (sql.includes('SELECT id,full_name,raffle_code,status FROM lottery_entries')) return [[{ id: 42, full_name: 'Ali Rezaei', raffle_code: 'LOT-ABCDEFGH', status: 'active' }]];
      if (sql.includes('SELECT id,full_name,phone,instagram,status FROM lottery_entries')) return [[{ id: 42, full_name: 'Ali Rezaei', phone: '09120000000', instagram: 'ali.old', status: 'active' }]];
      if (sql.includes('SELECT id,status FROM lottery_entries')) return [[{ id: 42, status: 'active' }]];
      if (sql.includes('SELECT id,full_name,phone,instagram,raffle_code,status,created_at,updated_at,deletion_reason')) return [[{ id: 42, full_name: 'Ali Rezaei', phone: '09121111111', instagram: 'ali.new', raffle_code: 'LOT-ABCDEFGH', status: 'active', created_at: 'now' }]];
      if (sql.includes('SELECT raffle_code,action,actor,created_at FROM lottery_code_history')) return [[]];
      if (sql.includes('SELECT id,full_name,phone,instagram,raffle_code,status FROM lottery_entries')) return [[{ id: 42, full_name: 'Ali Rezaei', phone: '09120000000', instagram: 'ali.old', raffle_code: 'LOT-ABCDEFGH', status: 'active' }]];
      if (sql.includes('SELECT full_name,phone,instagram,raffle_code,status,created_at FROM lottery_entries')) return [[]];
      if (sql.includes('SELECT d.id,d.winner_entry_id')) return [[]];
      return [{ affectedRows: 1 }];
    },
    async query(sql) {
      if (sql.includes('FROM lottery_entries')) return [[{ total: 0, active: 0, inactive: 0, deleted: 0 }]];
      if (sql.includes('FROM lottery_sessions')) return [[{ pending: 0 }]];
      if (sql.includes('FROM webhook_inbox')) return [[{ failed: 0 }]];
      if (sql.includes('FROM telegram_notification_outbox')) return [[{ failed: 0 }]];
      if (sql.includes('FROM campaigns')) return [[{ total: 0, open: 0, draft: 0, paused: 0, closed: 0 }]];
      if (sql.includes('FROM participants')) return [[{ total: 0, active: 0 }]];
      if (sql.includes('FROM campaign_codes')) return [[{ total: 0 }]];
      if (sql.includes('FROM payment_orders')) return [[{ total: 0, pending: 0, receipts: 0, approved: 0, rejected: 0 }]];
      if (sql.includes('FROM payment_transactions')) return [[]];
      if (sql.includes('FROM profile_change_requests')) return [[{ pending: 0 }]];
      if (sql.includes('FROM lottery_settings')) return [[{ setting_value: 'false' }]];
      return [[]];
    },
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


test('management dashboard reports multi-campaign, payment and reliability metrics', async () => {
  const h=harness();
  await h.admin.handleCallback({id:'dash1',data:'adm:stats',from:{id:12345},message:{chat:{id:12345,type:'private'}}});
  const body=h.telegram.find(x=>String(x.payload.text||'').includes('داشبورد مدیریتی'));
  assert.ok(body);
  assert.match(body.payload.text,/کمپین‌ها/);
  assert.match(body.payload.text,/پرداخت‌های تأییدشده/);
  assert.match(body.payload.text,/خطاهای Webhook/);
  assert.ok(JSON.stringify(body.payload.reply_markup).includes('adm:orders'));
});

test('campaign management supports validated status filters and pagination', async () => {
  const h=harness();
  await h.admin.handleCallback({id:'camp1',data:'adm:campaigns:open:2',from:{id:12345},message:{chat:{id:12345,type:'private'}}});
  const query=h.calls.find(x=>x.sql.includes('FROM campaigns c'));
  assert.ok(query);
  assert.match(query.sql,/WHERE c\.status=\?/);
  assert.deepEqual(query.params,['open',20]);
  assert.ok(h.telegram.some(x=>String(x.payload.text||'').includes('صفحه ۳ · open')));
  await h.admin.handleCallback({id:'camp2',data:'adm:campaigns:unknown:0',from:{id:12345},message:{chat:{id:12345,type:'private'}}});
  assert.ok(h.telegram.some(x=>String(x.payload.text||'').includes('فیلتر وضعیت کمپین نامعتبر')));
});

test('order management supports action queue, status filters and pagination', async () => {
  const h=harness();
  await h.admin.handleCallback({id:'ord1',data:'adm:orders:approved:1',from:{id:12345},message:{chat:{id:12345,type:'private'}}});
  const query=h.calls.find(x=>x.sql.includes('FROM payment_orders o JOIN campaigns c'));
  assert.ok(query);
  assert.match(query.sql,/WHERE o\.status=\?/);
  assert.deepEqual(query.params,['approved',10]);
  assert.ok(h.telegram.some(x=>String(x.payload.text||'').includes('صفحه ۲ · approved')));
  await h.admin.handleCallback({id:'ord2',data:'adm:orders:bad:0',from:{id:12345},message:{chat:{id:12345,type:'private'}}});
  assert.ok(h.telegram.some(x=>String(x.payload.text||'').includes('فیلتر سفارش نامعتبر')));
});

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
  await h.admin.handleCallback({ id: 'cb3', data: 'adm:edit:42', from: message.from, message: { chat: message.chat } });
  await h.admin.handleMessage({ ...message, text: 'Ali Rezaei | 09121111111 | ali.new' });
  await h.admin.handleCallback({ id: 'cb4', data: 'adm:apply-edit:42', from: message.from, message: { chat: message.chat } });
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
  await h.admin.handleCallback({ id: 'cb5', data: 'adm:delete:42', from: message.from, message: { chat: message.chat } });
  assert.equal(h.calls.some(x => x.sql.includes("status='deleted'")), false);
  await h.admin.handleCallback({ id: 'cb6', data: 'adm:apply-delete:42', from: message.from, message: { chat: message.chat } });
  const updateIndex = h.calls.findIndex(x => x.sql.includes("UPDATE lottery_entries SET status='deleted'"));
  const auditIndex = h.calls.findIndex(x => x.sql.includes('INSERT INTO admin_audit_log'));
  const commitIndex = h.calls.findIndex(x => x.sql === 'COMMIT');
  assert.ok(updateIndex >= 0);
  assert.ok(auditIndex > updateIndex);
  assert.ok(commitIndex > auditIndex);
  assert.equal(h.calls.some(x => x.sql === 'ROLLBACK'), false);
});


test('participant list supports status and date filters with parameterized status values', async () => {
  const h = harness();
  await h.admin.handleCallback({
    id: 'filter1', data: 'adm:entries:0:active:7d',
    from: { id: 12345 },
    message: { chat: { id: 12345, type: 'private' } }
  });
  const query = h.calls.find(x => x.sql.includes('FROM lottery_entries WHERE status <>'));
  assert.ok(query);
  assert.match(query.sql,/status = \?/);
  assert.match(query.sql,/DATE_SUB\(NOW\(\), INTERVAL 7 DAY\)/);
  assert.deepEqual(query.params, ['active', 0]);
  assert.ok(h.telegram.some(x => JSON.stringify(x.payload.reply_markup || {}).includes('entry-status')));
});


test('draw history is reachable from the Telegram draw menu', async () => {
  const h = harness();
  const callback = { id:'drawhist1',data:'adm:draw-history:0',from:{id:12345},message:{chat:{id:12345,type:'private'}} };
  await h.admin.handleCallback(callback);
  assert.ok(h.calls.some(x => x.sql.includes('FROM lottery_draws d LEFT JOIN lottery_draw_participants')));
  assert.ok(h.telegram.some(x => String(x.payload.text || '').includes('هنوز قرعه‌کشی ثبت‌شده‌ای وجود ندارد')));
});

test('filtered CSV export uses parameterized status and valid date windows', async () => {
  const h = harness();
  await h.admin.handleMessage({from:{id:12345},chat:{id:12345,type:'private'},text:'/export inactive 30d'});
  const query = h.calls.find(x => x.sql.includes('SELECT full_name,phone,instagram,raffle_code,status,created_at FROM lottery_entries'));
  assert.ok(query);
  assert.match(query.sql,/status = \?/);
  assert.match(query.sql,/DATE_SUB\(NOW\(\), INTERVAL 30 DAY\)/);
  assert.deepEqual(query.params,['inactive']);
});
