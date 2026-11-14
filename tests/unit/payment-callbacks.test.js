import test from 'node:test';
import assert from 'node:assert/strict';
import {paymentApproveAction,paymentRejectAction} from '../../src/modules/payments/payment-callbacks.js';

test('payment approval callback matches numeric receipt ids',()=>{
  const match='payment:approve:12345'.match(paymentApproveAction);
  assert.ok(match);
  assert.equal(match[1],'12345');
});

test('payment rejection callback matches numeric receipt ids',()=>{
  const match='payment:reject:987'.match(paymentRejectAction);
  assert.ok(match);
  assert.equal(match[1],'987');
});

test('payment callbacks reject malformed ids and unrelated actions',()=>{
  for(const value of ['payment:approve:','payment:approve:12x','payment:reject:-1','payment:reject:1:2','payment:resume:12']){
    assert.equal(paymentApproveAction.test(value)||paymentRejectAction.test(value),false,value);
  }
});
