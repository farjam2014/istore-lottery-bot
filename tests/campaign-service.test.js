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
