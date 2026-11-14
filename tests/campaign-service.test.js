'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertCampaignInput } = require('../src/campaign-service');

test('accepts a valid free campaign with independently configurable capacities', () => {
  const c = assertCampaignInput({
    name: 'Summer Giveaway',
    slug: 'summer-giveaway',
    payment_mode: 'free',
    max_participants: 500,
    max_codes: 1000,
    max_codes_per_participant: 2,
    winner_count: 3,
    alternate_count: 2
  });
  assert.equal(c.paymentMode, 'free');
  assert.equal(c.maxParticipants, 500);
  assert.equal(c.maxCodes, 1000);
  assert.equal(c.winnerCount, 3);
  assert.equal(c.alternateCount, 2);
});

test('rejects invalid slug and inconsistent free campaign price', () => {
  assert.throws(() => assertCampaignInput({ name: 'Bad', slug: 'Not Allowed', payment_mode: 'free' }));
  assert.throws(() => assertCampaignInput({ name: 'Bad', slug: 'bad-campaign', payment_mode: 'free', price_per_code: 100 }));
});

test('accepts manual payment campaign with a positive fixed price', () => {
  const c = assertCampaignInput({
    name: 'Paid Draw',
    slug: 'paid-draw',
    payment_mode: 'manual',
    price_per_code: 250000,
    currency: 'IRR'
  });
  assert.equal(c.paymentMode, 'manual');
  assert.equal(c.price, 250000);
});

test('rejects zero price for paid campaign and invalid limits', () => {
  assert.throws(() => assertCampaignInput({ name: 'Paid Draw', slug: 'paid-draw', payment_mode: 'manual', price_per_code: 0 }));
  assert.throws(() => assertCampaignInput({ name: 'Too Many', slug: 'too-many', max_codes: -1 }));
});


test('reservation expiry locks orders before reservations and cannot race receipt submission', async () => {
  const { createCampaignService } = require('../src/campaign-service');
  const statements = [];
  const conn = {
    async beginTransaction() { statements.push('BEGIN'); },
    async execute(sql, params = []) {
      statements.push({sql,params});
      if (sql.includes("SELECT id,entry_id FROM payment_orders")) return [[{id:71,entry_id:12},{id:72,entry_id:13}]];
      if (sql.includes("SELECT id,status,(expires_at<=UTC_TIMESTAMP()) AS is_expired")) {
        return [[{id:81,status:'held',is_expired:1}]];
      }
      if (sql.includes("UPDATE campaign_capacity_reservations SET status='expired'")) return [{affectedRows:1}];
      if (sql.includes("UPDATE payment_orders SET status='expired'")) return [{affectedRows:1}];
      return [{affectedRows:1}];
    },
    async commit() { statements.push('COMMIT'); },
    async rollback() { statements.push('ROLLBACK'); },
    release() { statements.push('RELEASE'); }
  };
  const service = createCampaignService({ db: { async getConnection() { return conn; } }, adminId: 'admin' });
  const result = await service.expireReservations();
  assert.deepEqual(result, { reservationsExpired: 2, ordersExpired: 2 });
  assert.equal(statements[0], 'BEGIN');
  const orderLock = statements.findIndex(x => typeof x==='object' && x.sql.includes('SELECT id,entry_id FROM payment_orders'));
  const reservationLock = statements.findIndex(x => typeof x==='object' && x.sql.includes('SELECT id,status,(expires_at<=UTC_TIMESTAMP()) AS is_expired'));
  const reservationWrite = statements.findIndex(x => typeof x==='object' && x.sql.includes("UPDATE campaign_capacity_reservations SET status='expired'"));
  const orderWrite = statements.findIndex(x => typeof x==='object' && x.sql.includes("UPDATE payment_orders SET status='expired'"));
  assert.ok(orderLock > 0 && reservationLock > orderLock);
  assert.ok(reservationWrite > reservationLock && orderWrite > reservationWrite);
  assert.match(statements[orderLock].sql,/FOR UPDATE SKIP LOCKED/);
  assert.equal(statements.at(-2),'COMMIT');
  assert.equal(statements.at(-1),'RELEASE');
});


test('replayed free campaign join returns existing codes without minting new ones', async () => {
  const { createCampaignService } = require('../src/campaign-service');
  const statements = [];
  const conn = {
    async beginTransaction() {},
    async commit() { statements.push('COMMIT'); },
    async rollback() {},
    release() {},
    async execute(sql) {
      statements.push(sql);
      if (sql.includes('SELECT * FROM campaigns')) return [[{ id: 7, status: 'open', payment_mode: 'free', max_codes_per_participant: 3 }]];
      if (sql.includes('SELECT * FROM participants')) return [[{ id: 11, status: 'active', telegram_user_id: '123', full_name: 'Test User', phone: '09120000000', instagram: 'testuser' }]];
      if (sql.includes('UPDATE participants SET chat_id')) return [{ affectedRows: 1 }];
      if (sql.includes('SELECT id,status FROM campaign_entries')) return [[{ id: 22, status: 'active' }]];
      if (sql.includes('SELECT code FROM campaign_codes')) return [[{ code: 'UST-ABC123' }, { code: 'UST-DEF456' }]];
      throw new Error('Unexpected SQL: ' + sql);
    }
  };
  const service = createCampaignService({ db: { async getConnection() { return conn; } }, adminId: 'admin' });
  const result = await service.joinFreeCampaign({
    campaignId: 7, telegramUserId: '123', chatId: '123',
    fullName: 'Test User', phone: '09120000000', instagram: 'testuser', quantity: 2
  });
  assert.equal(result.duplicate, true);
  assert.deepEqual(result.codes, ['UST-ABC123', 'UST-DEF456']);
  assert.equal(statements.filter(sql => sql.includes('INSERT INTO campaign_codes')).length, 0);
  assert.ok(statements.includes('COMMIT'));
});

test('replayed receipt upload with the same Telegram file unique id is idempotent', async () => {
  const { createCampaignService } = require('../src/campaign-service');
  const statements = [];
  const conn = {
    async beginTransaction() {},
    async commit() { statements.push('COMMIT'); },
    async rollback() {},
    release() {},
    async execute(sql) {
      statements.push(sql);
      if (sql.includes('SELECT id,status,expires_at,participant_id FROM payment_orders')) {
        return [[{ id: 41, status: 'receipt_submitted', participant_id: 11 }]];
      }
      if (sql.includes('SELECT id,telegram_file_unique_id FROM payment_receipts')) {
        return [[{ id: 55, telegram_file_unique_id: 'photo-unique-1' }]];
      }
      throw new Error('Unexpected SQL: ' + sql);
    }
  };
  const service = createCampaignService({ db: { async getConnection() { return conn; } }, adminId: 'admin' });
  const result = await service.submitReceipt({
    orderId: 41, fileId: 'telegram-file-id', fileUniqueId: 'photo-unique-1'
  });
  assert.equal(result.status, 'receipt_submitted');
  assert.equal(result.duplicate, true);
  assert.equal(statements.some(sql => sql.includes('INSERT INTO payment_receipts')), false);
  assert.ok(statements.includes('COMMIT'));
});


test('manual order persists receipt session and payment instructions before commit', async () => {
  const { createCampaignService } = require('../src/campaign-service');
  const calls = [];
  const conn = {
    async beginTransaction() { calls.push('BEGIN'); },
    async commit() { calls.push('COMMIT'); },
    async rollback() { calls.push('ROLLBACK'); },
    release() { calls.push('RELEASE'); },
    async execute(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT * FROM campaigns')) return [[{
        id: 3, name: 'Paid Campaign', status: 'open', payment_mode: 'manual',
        current_payment_card_id: 8, max_codes_per_participant: 2, max_participants: 100,
        max_codes: 200, price_per_code: 50000, currency: 'IRR'
      }]];
      if (sql.includes('SELECT id,label,bank_name,card_number')) return [[{
        id: 8, label: 'Main', bank_name: 'Bank', card_number: '6037990000000000',
        cardholder_name: 'USTORE', status: 'active'
      }]];
      if (sql.includes('SELECT id,status,telegram_user_id,chat_id,business_connection_id FROM participants')) return [[{
        id: 9, status: 'active', telegram_user_id: '12345', chat_id: '12345', business_connection_id: ''
      }]];
      if (sql.includes('SELECT id,order_ref,status,quantity,total_snapshot,currency,campaign_id FROM payment_orders')) return [[]];
      if (sql.includes('SELECT id,status FROM campaign_entries')) return [[{ id: 12, status: 'active' }]];
      if (sql.includes('SELECT id FROM campaign_capacity_reservations')) return [[]];
      if (sql.includes('AS participants_used')) return [[{ participants_used: 1, codes_used: 0 }]];
      if (sql.includes('AS codes_used')) return [[{ codes_used: 0 }]];
      if (sql.includes('INSERT INTO payment_orders')) return [{ insertId: 77 }];
      if (sql.includes('INSERT INTO campaign_capacity_reservations')) return [{ insertId: 88 }];
      if (sql.includes('INSERT INTO campaign_payment_sessions')) return [{ affectedRows: 1 }];
      if (sql.includes('INSERT IGNORE INTO telegram_notification_outbox')) return [{ affectedRows: 1 }];
      throw new Error('Unexpected SQL: ' + sql);
    }
  };
  const service = createCampaignService({ db: { async getConnection() { return conn; } }, adminId: 'admin' });
  const result = await service.reserveManualOrder({ campaignId: 3, participantId: 9, quantity: 1 });
  assert.equal(result.id, 77);
  const sessionIndex = calls.findIndex(x => typeof x === 'object' && x.sql.includes('INSERT INTO campaign_payment_sessions'));
  const outboxIndex = calls.findIndex(x => typeof x === 'object' && x.sql.includes('INSERT IGNORE INTO telegram_notification_outbox'));
  const commitIndex = calls.indexOf('COMMIT');
  assert.ok(sessionIndex > 0 && sessionIndex < commitIndex);
  assert.ok(outboxIndex > sessionIndex && outboxIndex < commitIndex);
  assert.equal(calls[sessionIndex].params[0], '12345');
  assert.equal(calls[sessionIndex].params[1], '12345');
  assert.equal(calls[sessionIndex].params[2], '');
  assert.match(calls[outboxIndex].params[0], /^payment-instructions:77$/);
  const orderInsert = calls.find(x => typeof x === 'object' && x.sql.includes('INSERT INTO payment_orders'));
  const termsSnapshot = JSON.parse(orderInsert.params[8]);
  assert.deepEqual(termsSnapshot.payment_card, {
    label: 'Main', bank_name: 'Bank', card_number: '6037990000000000', cardholder_name: 'USTORE'
  });
});


test('replayed pending manual order returns the existing order without creating another', async () => {
  const { createCampaignService } = require('../src/campaign-service');
  const statements = [];
  const conn = {
    async beginTransaction() {},
    async commit() { statements.push('COMMIT'); },
    async rollback() {},
    release() {},
    async execute(sql) {
      statements.push(sql);
      if (sql.includes('SELECT * FROM campaigns')) return [[{ id: 3, status: 'open', payment_mode: 'manual' }]];
      if (sql.includes('SELECT id,label,bank_name,card_number')) return [[{ id: 8, status: 'active' }]];
      if (sql.includes('SELECT id,status,telegram_user_id,chat_id,business_connection_id FROM participants')) return [[{ id: 9, status: 'active' }]];
      if (sql.includes('SELECT id,order_ref,status,quantity,total_snapshot,currency,campaign_id FROM payment_orders')) {
        return [[{ id: 77, order_ref: 'IS-ABC', status: 'pending_payment', quantity: 2, total_snapshot: 100000, currency: 'IRR', campaign_id: 3 }]];
      }
      throw new Error('Unexpected SQL: ' + sql);
    }
  };
  const service = createCampaignService({ db: { async getConnection() { return conn; } }, adminId: 'admin' });
  const result = await service.reserveManualOrder({ campaignId: 3, participantId: 9, quantity: 2 });
  assert.equal(result.duplicate, true);
  assert.equal(result.id, 77);
  assert.equal(result.orderRef, 'IS-ABC');
  assert.equal(result.total, 100000);
  assert.equal(statements.some(sql => sql.includes('INSERT INTO payment_orders')), false);
  assert.ok(statements.includes('COMMIT'));
});


test('pending manual order is not reused for a different campaign or quantity', async () => {
  const { createCampaignService } = require('../src/campaign-service');
  for (const scenario of [
    { campaignId: 4, quantity: 2, expected: /سفارش پرداخت‌نشده دیگری/ },
    { campaignId: 3, quantity: 1, expected: /با تعداد 2 کد باز دارید/ }
  ]) {
    const statements = [];
    const conn = {
      async beginTransaction() {},
      async commit() { statements.push('COMMIT'); },
      async rollback() { statements.push('ROLLBACK'); },
      release() {},
      async execute(sql) {
        statements.push(sql);
        if (sql.includes('SELECT * FROM campaigns')) return [[{
          id: scenario.campaignId, status: 'open', payment_mode: 'manual',
          current_payment_card_id: 8, max_codes_per_participant: 5
        }]];
        if (sql.includes('SELECT id,label,bank_name,card_number')) return [[{ id: 8, status: 'active' }]];
        if (sql.includes('SELECT id,status,telegram_user_id,chat_id,business_connection_id FROM participants')) return [[{ id: 9, status: 'active' }]];
        if (sql.includes('SELECT id,order_ref,status,quantity,total_snapshot,currency,campaign_id FROM payment_orders')) {
          return [[{ id: 77, order_ref: 'IS-ABC', status: 'pending_payment', quantity: 2, total_snapshot: 100000, currency: 'IRR', campaign_id: 3 }]];
        }
        throw new Error('Unexpected SQL: ' + sql);
      }
    };
    const service = createCampaignService({ db: { async getConnection() { return conn; } }, adminId: 'admin' });
    await assert.rejects(
      service.reserveManualOrder({ campaignId: scenario.campaignId, participantId: 9, quantity: scenario.quantity }),
      scenario.expected
    );
    assert.ok(statements.includes('ROLLBACK'));
    assert.equal(statements.includes('COMMIT'), false);
    assert.equal(statements.some(sql => sql.includes('INSERT INTO payment_orders')), false);
  }
});


test('customer cancellation releases an unpaid order reservation and payment session atomically', async () => {
  const { createCampaignService } = require('../src/campaign-service');
  const calls = [];
  const conn = {
    async beginTransaction() { calls.push('BEGIN'); },
    async commit() { calls.push('COMMIT'); },
    async rollback() { calls.push('ROLLBACK'); },
    release() { calls.push('RELEASE'); },
    async execute(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT id,campaign_id,entry_id,status FROM payment_orders')) {
        return [[{ id: 51, campaign_id: 3, entry_id: 12, status: 'pending_payment' }]];
      }
      if (sql.includes('SELECT chat_id,business_connection_id,order_ref')) {
        return [[{ chat_id: '12345', business_connection_id: '', order_ref: 'IS-XYZ' }]];
      }
      return [{ affectedRows: 1 }];
    }
  };
  const service = createCampaignService({ db: { async getConnection() { return conn; } }, adminId: 'admin' });
  const result = await service.cancelManualOrder({ orderId: 51, participantId: 9 });
  assert.deepEqual(result, { id: 51, status: 'cancelled' });
  const statements = calls.filter(x => typeof x === 'object').map(x => x.sql);
  assert.ok(statements.some(sql => sql.includes("UPDATE payment_orders SET status='cancelled'")));
  assert.ok(statements.some(sql => sql.includes("UPDATE campaign_capacity_reservations SET status='released'")));
  assert.ok(statements.some(sql => sql.includes('DELETE FROM campaign_payment_sessions')));
  assert.ok(statements.some(sql => sql.includes('INSERT INTO admin_audit_log')));
  assert.ok(calls.includes('COMMIT'));
  assert.ok(!calls.includes('ROLLBACK'));
});

test('customer cannot cancel a paid or receipt-submitted order', async () => {
  const { createCampaignService } = require('../src/campaign-service');
  const conn = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async execute(sql) {
      if (sql.includes('SELECT id,campaign_id,entry_id,status FROM payment_orders')) {
        return [[{ id: 52, campaign_id: 3, entry_id: 12, status: 'receipt_submitted' }]];
      }
      throw new Error('Unexpected SQL: ' + sql);
    }
  };
  const service = createCampaignService({ db: { async getConnection() { return conn; } }, adminId: 'admin' });
  await assert.rejects(
    service.cancelManualOrder({ orderId: 52, participantId: 9 }),
    /فقط سفارش در انتظار پرداخت قابل لغو است/
  );
});


test('replayed customer cancellation returns the already-cancelled order without repeating writes', async () => {
  const { createCampaignService } = require('../src/campaign-service');
  const calls = [];
  const conn = {
    async beginTransaction() {},
    async commit() { calls.push('COMMIT'); },
    async rollback() { calls.push('ROLLBACK'); },
    release() {},
    async execute(sql) {
      calls.push(sql);
      if (sql.includes('SELECT id,campaign_id,entry_id,status FROM payment_orders')) {
        return [[{ id: 53, campaign_id: 3, entry_id: 12, status: 'cancelled' }]];
      }
      throw new Error('Unexpected SQL: ' + sql);
    }
  };
  const service = createCampaignService({ db: { async getConnection() { return conn; } }, adminId: 'admin' });
  const result = await service.cancelManualOrder({ orderId: 53, participantId: 9 });
  assert.deepEqual(result, { id: 53, status: 'cancelled', duplicate: true });
  assert.deepEqual(calls, ['SELECT id,campaign_id,entry_id,status FROM payment_orders WHERE id=? AND participant_id=? FOR UPDATE', 'COMMIT']);
});


test('scheduled campaign can be closed before it opens', async () => {
  const { createCampaignService } = require('../src/campaign-service');
  const calls = [];
  const conn = {
    async beginTransaction() { calls.push('BEGIN'); },
    async execute(sql, params = []) {
      calls.push({sql,params});
      if (sql.includes('SELECT id,status,starts_at,ends_at FROM campaigns')) return [[{id:15,status:'scheduled'}], []];
      return [{affectedRows:1}, []];
    },
    async commit() { calls.push('COMMIT'); },
    async rollback() { calls.push('ROLLBACK'); },
    release() { calls.push('RELEASE'); }
  };
  const service = createCampaignService({db:{async getConnection(){return conn;}},adminId:'12345'});
  const result = await service.setCampaignStatus(15,'closed','cancel scheduled campaign');
  assert.deepEqual(result,{id:15,status:'closed'});
  assert.ok(calls.some(x=>typeof x==='object'&&x.sql.includes('UPDATE campaigns SET status=?')&&x.params[0]==='closed'));
  assert.ok(calls.includes('COMMIT'));
  assert.ok(!calls.includes('ROLLBACK'));
});


test('manual payment approval refuses inactive participants before issuing codes', async () => {
  const { createCampaignService } = require('../src/campaign-service');
  const calls = [];
  const conn = {
    async beginTransaction() { calls.push('BEGIN'); },
    async commit() { calls.push('COMMIT'); },
    async rollback() { calls.push('ROLLBACK'); },
    release() { calls.push('RELEASE'); },
    async execute(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT campaign_id,participant_id FROM payment_orders')) return [[{campaign_id:4,participant_id:17}]];
      if (sql.includes('SELECT id,status FROM campaigns')) return [[{id:4,status:'open'}]];
      if (sql.includes('SELECT id,status FROM participants')) return [[{ id: 17, status: 'inactive' }]];
      if (sql.includes('SELECT * FROM payment_orders')) return [[{
        id:91,status:'receipt_submitted',participant_id:17,campaign_id:4,
        expires_at:'2030-01-01 00:00:00',entry_id:23,quantity:2,total_snapshot:500000,currency:'IRR'
      }]];
      if (sql.includes('SELECT * FROM campaign_capacity_reservations')) return [[{id:33,status:'held'}]];
      if (sql.includes('AS submitted_in_time')) return [[{id:44,submitted_in_time:1}]];
      throw new Error('Unexpected SQL: ' + sql);
    }
  };
  const service = createCampaignService({ db: { async getConnection() { return conn; } }, adminId: 'admin' });
  await assert.rejects(
    service.reviewManualPayment({ orderId: 91, approve: true }),
    /شرکت‌کننده غیرفعال است/
  );
  assert.ok(calls.includes('ROLLBACK'));
  assert.ok(!calls.includes('COMMIT'));
  const campaignLock=calls.findIndex(x=>typeof x==='object'&&x.sql.includes('SELECT id,status FROM campaigns'));
  const participantLock=calls.findIndex(x=>typeof x==='object'&&x.sql.includes('SELECT id,status FROM participants'));
  const orderLock=calls.findIndex(x=>typeof x==='object'&&x.sql.includes('SELECT * FROM payment_orders'));
  assert.ok(campaignLock>0&&participantLock>campaignLock&&orderLock>participantLock,'payment review must lock campaign, participant, then order');
  assert.equal(calls.some(x => typeof x === 'object' && /INSERT INTO campaign_codes/.test(x.sql)), false);
  assert.equal(calls.some(x => typeof x === 'object' && /INSERT INTO payment_transactions/.test(x.sql)), false);
});

test('free campaign wizard skips payment-card selection and omits it from review edits', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/admin-telegram.js'), 'utf8');
  assert.match(source, /expected==='ends_at'&&p\.values\.payment_mode==='free'\)return campaignWizardReview\(chat,p\)/);
  assert.match(source, /filter\(\(\{f\}\)=>!\(v\.payment_mode==='free'&&f\.key==='payment_card_id'\)\)/);
});


test('campaign schedule worker opens and closes campaigns from database UTC decisions', async () => {
  const calls=[];
  const conn={
    async beginTransaction(){calls.push('BEGIN');},async commit(){calls.push('COMMIT');},async rollback(){calls.push('ROLLBACK');},release(){},
    async execute(sql,params=[]){
      calls.push({sql,params});
      if(sql.includes('CASE WHEN ends_at'))return [[
        {id:1,status:'scheduled',next_status:'open'},
        {id:2,status:'open',next_status:'closed'},
        {id:3,status:'scheduled',next_status:'closed'}
      ]];
      return [{affectedRows:1}];
    }
  };
  const service=require('../src/campaign-service').createCampaignService({db:{async getConnection(){return conn;}},adminId:'admin'});
  const result=await service.syncCampaignSchedule();
  assert.deepEqual(result,{opened:1,closed:2});
  assert.equal(calls.filter(x=>typeof x==='object'&&x.sql.startsWith('UPDATE campaigns SET status')).length,3);
  assert.equal(calls.filter(x=>typeof x==='object'&&x.sql.includes('INSERT INTO campaign_status_history')).length,3);
  assert.ok(calls.includes('COMMIT'));
});


test('campaign cannot be moved to scheduled without a start timestamp', async () => {
  const calls=[];
  const conn={
    async beginTransaction(){calls.push('BEGIN');},async commit(){calls.push('COMMIT');},async rollback(){calls.push('ROLLBACK');},release(){},
    async execute(sql,params=[]){
      calls.push({sql,params});
      if(sql.includes('SELECT id,status,starts_at,ends_at'))return [[{id:9,status:'draft',starts_at:null,ends_at:null}]];
      return [{affectedRows:1}];
    }
  };
  const service=require('../src/campaign-service').createCampaignService({db:{async getConnection(){return conn;}},adminId:'admin'});
  await assert.rejects(service.setCampaignStatus(9,'scheduled'),/زمان شروع داشته باشد/);
  assert.ok(calls.includes('ROLLBACK'));
  assert.ok(!calls.includes('COMMIT'));
});


test('campaign lifecycle rejects illegal backwards and premature transitions', async () => {
  async function attempt(current,next){
    const calls=[];
    const conn={
      async beginTransaction(){calls.push('BEGIN');},async commit(){calls.push('COMMIT');},async rollback(){calls.push('ROLLBACK');},release(){},
      async execute(sql){
        calls.push(sql);
        if(sql.includes('SELECT id,status,starts_at,ends_at'))return [[{id:9,status:current,starts_at:null,ends_at:null}]];
        return [{affectedRows:1}];
      }
    };
    const service=require('../src/campaign-service').createCampaignService({db:{async getConnection(){return conn;}},adminId:'admin'});
    await assert.rejects(service.setCampaignStatus(9,next),/تغییر وضعیت .* مجاز نیست/);
    assert.ok(calls.includes('ROLLBACK'));
    assert.ok(!calls.includes('COMMIT'));
  }
  await attempt('draft','closed');
  await attempt('open','draft');
  await attempt('closed','open');
});
