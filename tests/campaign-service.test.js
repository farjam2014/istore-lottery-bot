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


test('expires held capacity reservations and their pending payment orders transactionally', async () => {
  const { createCampaignService } = require('../src/campaign-service');
  const statements = [];
  const conn = {
    async beginTransaction() { statements.push('BEGIN'); },
    async execute(sql) {
      statements.push(sql);
      if (sql.includes('UPDATE campaign_capacity_reservations')) return [{ affectedRows: 2 }];
      if (sql.includes('UPDATE payment_orders')) return [{ affectedRows: 2 }];
      return [{ affectedRows: 1 }];
    },
    async commit() { statements.push('COMMIT'); },
    async rollback() { statements.push('ROLLBACK'); },
    release() { statements.push('RELEASE'); }
  };
  const service = createCampaignService({ db: { async getConnection() { return conn; } }, adminId: 'admin' });
  const result = await service.expireReservations();
  assert.deepEqual(result, { reservationsExpired: 2, ordersExpired: 2 });
  assert.equal(statements[0], 'BEGIN');
  assert.equal(statements.at(-2), 'COMMIT');
  assert.equal(statements.at(-1), 'RELEASE');
  assert.match(statements[1], /expires_at<=UTC_TIMESTAMP/);
  assert.match(statements[1], /NOT EXISTS .*status='receipt_submitted'/);
  assert.match(statements[2], /o\.status='pending_payment'/);
  assert.doesNotMatch(statements[2], /receipt_submitted/);
});
