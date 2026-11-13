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
      if (sql.includes("FROM lottery_settings")) return [[{ setting_value: 'false' }]];
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
  const cardRows=new Map();
  const bankCardService={
    async listCards(){return [...cardRows.values()];},
    async getCard(id){const c=cardRows.get(Number(id));if(!c)throw new Error('card not found');return c;},
    async addCard(input){calls.push({sql:'ADD_BANK_CARD',input});const c={id:77,label:input.label,bank_name:input.bankName,card_number:input.cardNumber,cardholder_name:input.cardholderName,status:'active'};cardRows.set(77,c);return {id:77};},
    async updateCard(input){calls.push({sql:'UPDATE_BANK_CARD',input});const c={id:input.id,label:input.label,bank_name:input.bankName,card_number:input.cardNumber,cardholder_name:input.cardholderName,status:'active'};cardRows.set(input.id,c);},
    async setCardStatus(){},
    async deleteCard(id){calls.push({sql:'DELETE_BANK_CARD',id});if(!cardRows.has(Number(id)))throw new Error('کارت پیدا نشد.');cardRows.delete(Number(id));}
  };
  const admin = createAdminTelegram({
    db, tg, tgDocument: async () => ({ ok: true }), bankCardService,
    adminId: '12345', registrationOpen: async () => false,
    campaignService: { async createCampaign(input) { calls.push({ sql: 'CREATE_CAMPAIGN', input }); return { id: 88, slug: input.slug }; }, async updateDraftCampaign(id,input) { calls.push({ sql: 'UPDATE_DRAFT_CAMPAIGN', id, input }); return { id, slug: input.slug }; } }
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
  assert.ok(h.telegram.some(x=>String(x.payload.text||'').includes('صفحه 3 · open')));
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
  assert.ok(h.telegram.some(x=>String(x.payload.text||'').includes('صفحه 2 · approved')));
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


test('campaign creation uses a step-by-step wizard and final review before saving', async () => {
  const h=harness();
  const message={from:{id:12345},chat:{id:12345,type:'private'}};
  await h.admin.handleCallback({id:'wizard-start',data:'adm:campaign-create',from:message.from,message:{chat:message.chat}});
  const answers=['کمپین پاییز','autumn-1405','free','-','-','1','1','0','system','per_code'];
  for(const answer of answers) await h.admin.handleMessage({...message,text:answer});
  assert.ok(h.telegram.some(x=>String(x.payload.text||'').includes('بازبینی اطلاعات کمپین')), 'wizard did not reach review; messages: '+h.telegram.map(x=>x.payload.text).join(' | '));
  assert.equal(h.calls.some(x=>x.sql==='CREATE_CAMPAIGN'),false);
  await h.admin.handleCallback({id:'wizard-save',data:'adm:campaign-wizard-save',from:message.from,message:{chat:message.chat}});
  const created=h.calls.find(x=>x.sql==='CREATE_CAMPAIGN');
  assert.ok(created);
  assert.equal(created.input.slug,'autumn-1405');
  assert.equal(created.input.payment_mode,'free');
  assert.equal(created.input.payment_card_id,null);
  assert.ok(h.telegram.some(x=>String(x.payload.text||'').includes('کمپین در وضعیت پیش‌نویس ساخته شد')));
});


test('bank card creation uses a conversational wizard and masks the card number in review', async () => {
  const h=harness(), message={from:{id:12345},chat:{id:12345,type:'private'}};
  await h.admin.handleCallback({id:'card-add',data:'adm:card-add',from:message.from,message:{chat:message.chat}});
  const answers=['کارت فروشگاه','ملت','6037991234567890','علی رضایی'];
  for(const answer of answers) await h.admin.handleMessage({...message,text:answer});
  const review=h.telegram.at(-1).payload.text;
  assert.match(review,/بازبینی اطلاعات کارت/);
  assert.match(review,/•••• •••• •••• 7890/);
  assert.equal(review.includes('6037991234567890'),false);
  assert.equal(h.calls.some(x=>x.sql==='ADD_BANK_CARD'),false);
  await h.admin.handleCallback({id:'card-save',data:'adm:card-wizard-save',from:message.from,message:{chat:message.chat}});
  const created=h.calls.find(x=>x.sql==='ADD_BANK_CARD');
  assert.ok(created);
  assert.equal(created.input.cardNumber,'6037991234567890');
  assert.ok(h.telegram.some(x=>String(x.payload.text||'').includes('کارت فروشگاه')));
});

test('bank card wizard supports back navigation and invalid card numbers without losing entered data', async () => {
  const h=harness(), message={from:{id:12345},chat:{id:12345,type:'private'}};
  await h.admin.handleCallback({id:'card-add',data:'adm:card-add',from:message.from,message:{chat:message.chat}});
  await h.admin.handleMessage({...message,text:'کارت فروشگاه'});
  await h.admin.handleMessage({...message,text:'ملت'});
  await h.admin.handleMessage({...message,text:'/back'});
  assert.match(h.telegram.at(-1).payload.text,/نام بانک/);
  await h.admin.handleMessage({...message,text:'ملت'});
  await h.admin.handleMessage({...message,text:'123'});
  assert.match(h.telegram.at(-1).payload.text,/مقدار نامعتبر است/);
  assert.equal(h.calls.some(x=>x.sql==='ADD_BANK_CARD'),false);
});

test('admin menus and conversational wizard reuse the same Telegram message', async () => {
  const h = harness();
  const callbackMessage = {
    message_id: 9001,
    chat: { id: 12345, type: 'private' }
  };
  await h.admin.handleCallback({
    id: 'card-menu', data: 'adm:cards',
    from: { id: 12345 }, message: callbackMessage
  });
  const firstEdit = h.telegram.find(x => x.method === 'editMessageText');
  assert.ok(firstEdit);
  assert.equal(firstEdit.payload.message_id, 9001);

  await h.admin.handleCallback({
    id: 'card-add', data: 'adm:card-add',
    from: { id: 12345 }, message: callbackMessage
  });
  const wizardEdit = h.telegram.filter(x => x.method === 'editMessageText').at(-1);
  assert.equal(wizardEdit.payload.message_id, 9001);
  assert.match(wizardEdit.payload.text, /عنوان کارت/);

  await h.admin.handleMessage({
    from: { id: 12345 }, chat: { id: 12345, type: 'private' },
    text: 'کارت اصلی'
  });
  const nextStepEdit = h.telegram.filter(x => x.method === 'editMessageText').at(-1);
  assert.equal(nextStepEdit.payload.message_id, 9001);
  assert.match(nextStepEdit.payload.text, /نام بانک/);
});


test('campaign and bank-card wizards expose inline back/cancel controls and Persian payment choices', async () => {
  const h = harness();
  const message = { from: { id: 12345 }, chat: { id: 12345, type: 'private' } };
  const click = async (id, data) => h.admin.handleCallback({ id, data, from: message.from, message: { ...message.chat, chat: message.chat } });

  await click('inline-campaign-start', 'adm:campaign-create');
  let markup = h.telegram.at(-1).payload.reply_markup.inline_keyboard;
  assert.ok(markup.flat().some(b => b.callback_data === 'adm:campaign-wizard-back'));
  assert.ok(markup.flat().some(b => b.callback_data === 'adm:campaign-wizard-cancel'));

  await h.admin.handleMessage({ ...message, text: 'کمپین آزمایشی' });
  await h.admin.handleMessage({ ...message, text: 'test-campaign' });
  markup = h.telegram.at(-1).payload.reply_markup.inline_keyboard;
  assert.ok(markup.flat().some(b => b.text.includes('رایگان') && b.callback_data.endsWith(':free')));
  assert.ok(markup.flat().some(b => b.text.includes('پولی') && b.callback_data.endsWith(':manual')));

  await click('choose-paid', 'adm:campaign-wizard-payment:manual');
  assert.match(h.telegram.at(-1).payload.text, /مبلغ هر کد/);
  await click('go-back-payment', 'adm:campaign-wizard-back');
  assert.ok(h.telegram.at(-1).payload.reply_markup.inline_keyboard.flat().some(b => b.text.includes('رایگان')));

  await click('choose-free', 'adm:campaign-wizard-payment:free');
  assert.match(h.telegram.at(-1).payload.text, /سقف شرکت‌کنندگان/);

  await click('cancel-campaign', 'adm:campaign-wizard-cancel');
  await click('start-card', 'adm:card-add');
  markup = h.telegram.at(-1).payload.reply_markup.inline_keyboard;
  assert.ok(markup.flat().some(b => b.callback_data === 'adm:card-wizard-back'));
  assert.ok(markup.flat().some(b => b.callback_data === 'adm:card-wizard-cancel'));
  await click('card-back', 'adm:card-wizard-back');
  assert.match(h.telegram.at(-1).payload.text, /عنوان کارت/);
});


test('bank card detail accepts numeric IDs and supports confirmed deletion', async () => {
  const h = harness(), message = { from: { id: 12345 }, chat: { id: 12345, type: 'private' } };
  await h.admin.handleCallback({ id: 'add-card-for-delete', data: 'adm:card-add', from: message.from, message: { chat: message.chat } });
  for (const value of ['Unused card', 'Bank', '6037991234567890', 'Test Holder']) {
    await h.admin.handleMessage({ ...message, text: value });
  }
  await h.admin.handleCallback({ id: 'save-card-for-delete', data: 'adm:card-wizard-save', from: message.from, message: { chat: message.chat } });
  await h.admin.handleCallback({ id: 'open-card-detail', data: 'adm:card:77', from: message.from, message: { chat: message.chat } });
  assert.match(h.telegram.at(-1).payload.text, /Unused card/);
  assert.ok(h.telegram.at(-1).payload.reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'adm:card-delete:77'));
  await h.admin.handleCallback({ id: 'request-card-delete', data: 'adm:card-delete:77', from: message.from, message: { chat: message.chat } });
  assert.match(h.telegram.at(-1).payload.text, /حذف دائمی کارت/);
  await h.admin.handleCallback({ id: 'confirm-card-delete', data: 'adm:card-delete-apply:77', from: message.from, message: { chat: message.chat } });
  assert.ok(h.calls.some(x => x.sql === 'DELETE_BANK_CARD' && x.id === 77));
  assert.match(h.telegram.at(-1).payload.text, /کارت‌های ثبت‌شده|هنوز کارتی ثبت نشده/);
});


test('campaign wizard uses inline Persian buttons for draw settings and shows selectable bank-card IDs', async () => {
  const h=harness(), message={from:{id:12345},chat:{id:12345,type:'private'}};
  await h.admin.handleCallback({id:'new-card',data:'adm:card-add',from:message.from,message:{chat:message.chat}});
  for(const value of ['کارت اصلی','ملت','6037991234567890','علی رضایی']) {
    await h.admin.handleMessage({...message,text:value});
  }
  await h.admin.handleCallback({id:'save-card',data:'adm:card-wizard-save',from:message.from,message:{chat:message.chat}});

  await h.admin.handleCallback({id:'start-campaign',data:'adm:campaign-create',from:message.from,message:{chat:message.chat}});
  for(const value of ['کمپین پولی','paid-campaign']) await h.admin.handleMessage({...message,text:value});
  await h.admin.handleCallback({id:'paid',data:'adm:campaign-wizard-payment:manual',from:message.from,message:{chat:message.chat}});
  for(const value of ['1000','-','-','2','1','0']) await h.admin.handleMessage({...message,text:value});

  let markup=h.telegram.at(-1).payload.reply_markup.inline_keyboard;
  assert.ok(markup.flat().some(b=>b.text==='🎡 از گردونه'&&b.callback_data.endsWith(':live_wheel')));
  assert.ok(markup.flat().some(b=>b.text==='🤖 از خود ربات'&&b.callback_data.endsWith(':system')));
  assert.equal(h.telegram.at(-1).payload.text.includes('live_wheel'),false);
  await h.admin.handleCallback({id:'wheel',data:'adm:campaign-wizard-draw-method:live_wheel',from:message.from,message:{chat:message.chat}});

  markup=h.telegram.at(-1).payload.reply_markup.inline_keyboard;
  assert.ok(markup.flat().some(b=>b.text==='🎟 به ازای هر کد'&&b.callback_data.endsWith(':per_code')));
  assert.ok(markup.flat().some(b=>b.text==='👤 به ازای هر شرکت‌کننده'&&b.callback_data.endsWith(':per_participant')));
  assert.equal(h.telegram.at(-1).payload.text.includes('per_code'),false);
  await h.admin.handleCallback({id:'per-code',data:'adm:campaign-wizard-draw-basis:per_code',from:message.from,message:{chat:message.chat}});

  markup=h.telegram.at(-1).payload.reply_markup.inline_keyboard;
  const cardButton=markup.flat().find(b=>b.callback_data==='adm:campaign-wizard-card:77');
  assert.ok(cardButton);
  assert.match(cardButton.text,/#77/);
  await h.admin.handleCallback({id:'choose-card',data:'adm:campaign-wizard-card:77',from:message.from,message:{chat:message.chat}});
  assert.match(h.telegram.at(-1).payload.text,/بازبینی اطلاعات کمپین/);
  await h.admin.handleCallback({id:'save-campaign',data:'adm:campaign-wizard-save',from:message.from,message:{chat:message.chat}});
  const created=h.calls.find(x=>x.sql==='CREATE_CAMPAIGN');
  assert.ok(created);
  assert.equal(created.input.draw_method,'live_wheel');
  assert.equal(created.input.draw_basis,'per_code');
  assert.equal(created.input.payment_card_id,77);
});
