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
    phone:'09125550000',
    instagram_handle:'private_handle',
    from:{id:'333333'},
    nested:{chatId:'444444',full_name:'Private Person'}
  },'redaction test');
  assert.match(output,/\[REDACTED\]/);
  for(const secret of ['111111','222222','09125550000','private_handle','333333','444444','Private Person','private_telegram_name','Private First','Private Last','nested_private_name']){
    assert.equal(output.includes(secret),false,'sensitive value leaked: '+secret);
  }
});
