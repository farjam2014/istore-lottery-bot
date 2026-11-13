'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { wrapAsyncHandler, patchAsyncRoutes, createErrorMiddleware } = require('../src/async-route');
const { acquireMigrationLock } = require('../src/migration-lock');

test('async route rejections are forwarded to Express next', async () => {
  const expected = new Error('database unavailable');
  let forwarded;
  const handler = wrapAsyncHandler(async () => { throw expected; });
  await handler({}, {}, error => { forwarded = error; });
  assert.equal(forwarded, expected);
});

test('synchronous route exceptions are forwarded to Express next', async () => {
  const expected = new Error('sync failure');
  let forwarded;
  wrapAsyncHandler(() => { throw expected; })({}, {}, error => { forwarded = error; });
  await Promise.resolve();
  assert.equal(forwarded, expected);
});

test('all supported Express route methods wrap their handlers', async () => {
  const methods = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all'];
  const app = {};
  for (const method of methods) app[method] = function(path, ...handlers) { this.last = { path, handlers }; return this; };
  patchAsyncRoutes(app);
  const handler = async () => 'ok';
  app.post('/test', handler);
  assert.notEqual(app.last.handlers[0], handler);
  assert.equal(await app.last.handlers[0]({}, {}, error => { throw error; }), 'ok');
});

test('error middleware returns a safe 500 response without leaking details', () => {
  let logged, status, body;
  const middleware = createErrorMiddleware({ error: (...values) => { logged = values.join(' '); } });
  const res = { headersSent: false, status(value) { status = value; return this; }, json(value) { body = value; return value; } };
  middleware(new Error('secret SQL detail'), {}, res, () => {});
  assert.equal(status, 500);
  assert.deepEqual(body, { error: 'خطای داخلی سرور.' });
  assert.match(logged, /secret SQL detail/);
});

test('migration lock is acquired and released exactly once', async () => {
  const calls = [];
  const db = { async execute(sql, params) { calls.push([sql, params]); return [[{ acquired: 1, released: 1 }]]; } };
  const release = await acquireMigrationLock(db, 'test_lock', 12);
  await release();
  await release();
  assert.equal(calls.length, 2);
  assert.match(calls[0][0], /GET_LOCK/);
  assert.match(calls[1][0], /RELEASE_LOCK/);
});

test('migration aborts when another process owns the lock', async () => {
  const db = { async execute() { return [[{ acquired: 0 }]]; } };
  await assert.rejects(acquireMigrationLock(db, 'test_lock', 1), /another migration may be running/);
});


test('Express integration converts a rejected async route into a safe HTTP 500', async () => {
  const app = express();
  patchAsyncRoutes(app);
  app.get('/async-failure', async () => { throw new Error('private database detail'); });
  app.use(createErrorMiddleware({ error: () => {} }));
  const server = app.listen(0);
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/async-failure`);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'خطای داخلی سرور.' });
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('a second migration process cannot enter until the first releases its lock', async () => {
  let held = false;
  const makeConnection = () => ({
    async execute(sql) {
      if (sql.includes('GET_LOCK')) {
        if (held) return [[{ acquired: 0 }]];
        held = true;
        return [[{ acquired: 1 }]];
      }
      if (sql.includes('RELEASE_LOCK')) {
        held = false;
        return [[{ released: 1 }]];
      }
      throw new Error('Unexpected SQL');
    }
  });
  const first = await acquireMigrationLock(makeConnection(), 'shared_lock', 1);
  await assert.rejects(acquireMigrationLock(makeConnection(), 'shared_lock', 1), /another migration may be running/);
  await first();
  const second = await acquireMigrationLock(makeConnection(), 'shared_lock', 1);
  await second();
});


test('customer phone is accepted only from the owner Telegram contact', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/index.js'), 'utf8');
  assert.match(source, /if\(m\.contact\)/);
  assert.match(source, /!m\.contact\.user_id\|\|String\(m\.contact\.user_id\)!==uid/);
  assert.match(source, /profile_awaiting_contact/);
  assert.doesNotMatch(source, /s\.step==="phone"/);
});

test('profile confirmation is bound to the Telegram user, chat and Business connection', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/index.js'), 'utf8');
  const start = source.indexOf('if(q.data==="profile:confirm")');
  const end = source.indexOf("if(String(q.data||'').startsWith('campaign:details:')", start);
  const handler = source.slice(start, end);
  assert.match(handler, /s\.step!=="profile_confirmation"/);
  assert.match(handler, /String\(s\.chat_id\)!==chat/);
  assert.match(handler, /String\(s\.business_connection_id\|\|""\)!==connection/);
});

test('profile confirmation persists the profile before clearing the session', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/index.js'), 'utf8');
  const start = source.indexOf('if(q.data==="profile:confirm")');
  const end = source.indexOf("if(String(q.data||'').startsWith('campaign:details:')", start);
  const handler = source.slice(start, end);
  assert.match(handler, /await saveParticipantProfile\([\s\S]*?await delSession\(uid\)/);
  assert.match(handler, /پروفایل شما با موفقیت ساخته شد/);
});

test('optional contact gate fails open when CONTACT_PHONE is unset or invalid', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/index.js'), 'utf8');
  assert.match(source, /function configuredContactPhone\(\)/);
  assert.match(source, /if\(!configuredContactPhone\(\)\)return true/);
  assert.match(source, /if\(!await contactGateAccepted\(uid\)\)/);
});

test('multi-campaign Business flow supports campaign listing, joins, and payment receipt photos', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/index.js'), 'utf8');
  assert.match(source, /lower==='کمپین‌ها'\|\|lower==='کمپین ها'\|\|lower==='\/campaigns'/);
  assert.match(source, /campaignService\.joinFreeCampaign\(\{campaignId:Number\(campaignId\),telegramUserId:uid,chatId:chat,businessConnectionId:connection/);
  assert.match(source, /campaignService\.reserveManualOrder\(\{campaignId:Number\(campaignId\),participantId:participant\.id,quantity\}\)/);
  assert.match(source, /campaignService\.submitReceipt\(\{orderId:paymentSession\.order_id,fileId:photo\.file_id/);
  assert.match(source, /business_connection_id=\? LIMIT 1/);
});

test('campaign payment session schema binds one pending order to a Telegram Business user', () => {
  const { CAMPAIGN_SCHEMA } = require('../migrations/multi-campaign');
  const schema = CAMPAIGN_SCHEMA.find(sql => sql.includes('CREATE TABLE IF NOT EXISTS campaign_payment_sessions'));
  assert.ok(schema);
  assert.match(schema, /telegram_user_id BIGINT NOT NULL PRIMARY KEY/);
  assert.match(schema, /business_connection_id VARCHAR\(128\) NOT NULL/);
  assert.match(schema, /FOREIGN KEY\(order_id\) REFERENCES payment_orders\(id\)/);
});

test('new customer profile onboarding is independent of campaign availability', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/index.js'), 'utf8');
  assert.match(source, /if\(q\.data==="profile:create"\)/);
  assert.match(source, /نام و نام خانوادگی خود را برای ساخت پروفایل دائمی وارد کنید؛ حتی بدون کمپین فعال/);
  assert.match(source, /async function saveParticipantProfile\(/);
  assert.match(source, /INSERT INTO participants\(telegram_user_id,chat_id,business_connection_id,full_name,phone,instagram,status\)/);
  assert.doesNotMatch(source, /legacyRegistrationOpen|lottery_entries|lottery_settings/);
});


test('customer can create a persistent profile without an open campaign', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/index.js'), 'utf8');
  assert.match(source, /if\(q\.data==="profile:create"\)/);
  assert.match(source, /async function saveParticipantProfile\(/);
  assert.match(source, /if\(q\.data==="profile:confirm"\)/);
  assert.match(source, /INSERT INTO participants\(telegram_user_id,chat_id,business_connection_id,full_name,phone,instagram,status\)/);
});

test('customer profile edits, codes and support have interactive routes', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/index.js'), 'utf8');
  assert.match(source, /profile:edit:name/);
  assert.match(source, /profile:edit:phone/);
  assert.match(source, /profile:edit:instagram/);
  assert.match(source, /if\(q\.data==='participant:codes'\)/);
  assert.match(source, /customer_support_tickets/);
  assert.match(source, /\/reply/);
});

test('customer flow migration creates support tickets; session states belong to fresh bootstrap', () => {
  const migration = require('../migrations/customer-flow');
  assert.equal(typeof migration.up, 'function');
  const fs = require('node:fs');
  const customerFlow = fs.readFileSync(require.resolve('../migrations/customer-flow'), 'utf8');
  const bootstrap = fs.readFileSync(require.resolve('../migrations/run'), 'utf8');
  assert.match(customerFlow, /CREATE TABLE IF NOT EXISTS customer_support_tickets/);
  assert.match(customerFlow, /status ENUM\('open','answered','closed'\)/);
  assert.match(bootstrap, /CREATE TABLE IF NOT EXISTS telegram_sessions/);
  assert.match(bootstrap, /profile_confirmation/);
  assert.match(bootstrap, /support_message/);
});