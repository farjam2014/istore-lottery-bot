'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCampaignCode } = require('../src/campaign-service');

test('campaign codes are deterministic for an internal campaign sequence', () => {
  const secret = 'test-only-secret-that-is-at-least-32-characters';
  const a = makeCampaignCode(7, 1, secret);
  assert.match(a, /^IS-[A-F0-9]{12}$/);
  assert.equal(a, makeCampaignCode(7, 1, secret));
  assert.notEqual(a, makeCampaignCode(7, 2, secret));
  assert.notEqual(a, makeCampaignCode(8, 1, secret));
});

test('campaign code generation rejects weak or missing secrets', () => {
  assert.throws(() => makeCampaignCode(1, 1, 'short'));
  assert.throws(() => makeCampaignCode(1, 1, ''));
});
