import test from 'node:test';
import assert from 'node:assert/strict';
import {isTelegramCommandText} from '../../src/modules/admin/admin-role-session.js';

test('admin role wizard yields Telegram commands to later handlers',()=>{
  for(const value of ['/payments','/admin','/cancel','/payments@ustorelotterybot','/payments 123']){
    assert.equal(isTelegramCommandText(value),true,value);
  }
});

test('admin role wizard keeps ordinary text for Telegram ID validation',()=>{
  for(const value of ['237573106','not-a-command','payments','/ invalid','']){
    assert.equal(isTelegramCommandText(value),false,value);
  }
});
