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
