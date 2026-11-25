import test from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import {logRedactPaths} from '../../src/shared/log-redaction.js';

test('structured logs redact Telegram IDs, phone numbers, Instagram handles, and nested identifiers',()=>{
  let output='';
  const destination={write(chunk){output+=String(chunk);}};
  const log=pino({level:'error',redact:{paths:logRedactPaths,censor:'[REDACTED]'}},destination);
  log.error({
    userId:'111111',
    telegram_user_id:'222222',
    adminTelegramId:'555555',
    phone:'09125550000',
    instagram_handle:'private_handle',
    from:{id:'333333'},
    nested:{chatId:'444444',adminTelegramId:'666666',full_name:'Private Person'}
  },'redaction test');
  assert.match(output,/\[REDACTED\]/);
  for(const secret of ['111111','222222','555555','666666','09125550000','09125550001','private_handle','333333','444444','Private Person','private_telegram_name','Private First','Private Last','nested_private_name']){
    assert.equal(output.includes(secret),false,'sensitive value leaked: '+secret);
  }
});


test('structured error logs redact raw database and nested error messages and stacks',()=>{
  let output='';
  const destination={write(chunk){output+=String(chunk);}};
  const log=pino({level:'error',redact:{paths:logRedactPaths,censor:'[REDACTED]'}},destination);
  const duplicate=new Error("Duplicate entry '09125550000' for key 'participants.phone'");
  duplicate.code='ER_DUP_ENTRY';
  const remote=new Error('Telegram request failed for @private_handle and 998877665544');
  log.error({err:duplicate,nested:{err:remote}},'sensitive error test');
  assert.match(output,/ER_DUP_ENTRY/);
  for(const secret of ['09125550000','private_handle','998877665544','Duplicate entry','Telegram request failed'])assert.equal(output.includes(secret),false,'sensitive error content leaked: '+secret);
});
