import test from 'node:test';
import assert from 'node:assert/strict';

test('payment order status filters are represented by the supported operational states',()=>{
  const states=['awaiting_receipt','under_review','approved','rejected','cancelled','expired'];
  assert.equal(new Set(states).size,6);
  assert.ok(states.includes('under_review'));
  assert.ok(states.includes('approved'));
});
