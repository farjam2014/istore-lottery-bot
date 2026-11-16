import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCardNumber} from '../../src/modules/payments/bank-card.service.js';

test('card number normalization removes spaces and hyphens',()=>{
  assert.equal(normalizeCardNumber('4111 1111-2222 3333'),'4111111122223333');
});

test('card number normalization rejects non-16-digit values',()=>{
  for(const value of ['', '123456789012345', '12345678901234567', '1234-5678-9012-abcd']){
    assert.throws(()=>normalizeCardNumber(value),/دقیقاً ۱۶ رقم/);
  }
});

test('card number normalization rejects nullish values',()=>{
  assert.throws(()=>normalizeCardNumber(null),/دقیقاً ۱۶ رقم/);
  assert.throws(()=>normalizeCardNumber(undefined),/دقیقاً ۱۶ رقم/);
});
