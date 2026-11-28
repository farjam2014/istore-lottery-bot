import test from 'node:test';
import assert from 'node:assert/strict';
import {isRegistrationUpdateAllowed} from '../../src/bot/middleware/registration-gate.js';

test('allows the native contact only while the user is at the phone step',()=>{
  assert.equal(isRegistrationUpdateAllowed({session:{step:'awaiting_phone'},message:{contact:{phone_number:'09120000000'}}}),true);
});
test('blocks a contact outside the phone step',()=>{
  assert.equal(isRegistrationUpdateAllowed({session:{step:'awaiting_instagram'},message:{contact:{phone_number:'09120000000'}}}),false);
});
test('does not allow contact sharing without an active registration session',()=>{
  assert.equal(isRegistrationUpdateAllowed({message:{contact:{phone_number:'09120000000'}}}),false);
});
test('keeps registration callbacks and commands available before profile creation',()=>{
  assert.equal(isRegistrationUpdateAllowed({callbackData:'registration:start'}),true);
  assert.equal(isRegistrationUpdateAllowed({command:'/start'}),true);
});

test('allows only version-bound privacy consent callbacks',()=>{
  assert.equal(isRegistrationUpdateAllowed({callbackData:'pa:-1:v1'}),true);
  assert.equal(isRegistrationUpdateAllowed({callbackData:'pa:12345:notice_2026.11'}),true);
  assert.equal(isRegistrationUpdateAllowed({callbackData:'pa:-1:'}),false);
  assert.equal(isRegistrationUpdateAllowed({callbackData:'privacy:accept:-1'}),false);
});
