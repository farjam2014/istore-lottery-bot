import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAdminIds} from '../../src/modules/payments/admin-recipients.js';

test('normalizes configured admin IDs from a Set', () => {
  assert.deepEqual(normalizeAdminIds(new Set(['123', '456'])), ['123', '456']);
});

test('normalizes admin IDs from arrays and comma-separated strings', () => {
  assert.deepEqual(normalizeAdminIds(['123', 456]), ['123', '456']);
  assert.deepEqual(normalizeAdminIds('123, 456'), ['123', '456']);
});

test('returns an empty list for missing admin IDs and wraps a scalar', () => {
  assert.deepEqual(normalizeAdminIds(undefined), []);
  assert.deepEqual(normalizeAdminIds(123), ['123']);
});
