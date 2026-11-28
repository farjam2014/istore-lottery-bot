import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {classifyTelegramDeliveryError,safeTelegramDeliveryErrorLabel} from '../../src/modules/notifications/outbox.worker.js';

test('outbox classifies Telegram errors without persisting or logging exception content',()=>{
  const secret='phone +989121234567 receipt SECRET-123';
  const tooMany=Object.assign(new Error(secret),{response:{error_code:429,parameters:{retry_after:17},description:secret}});
  const badRequest=Object.assign(new Error(secret),{response:{error_code:400,description:secret}});
  const server=Object.assign(new Error(secret),{response:{error_code:500,description:secret}});
  const network=Object.assign(new Error(secret),{code:'ECONNRESET'});
  assert.deepEqual(classifyTelegramDeliveryError(tooMany,1),{status:'pending',delaySeconds:17,errorLabel:'telegram_http_429'});
  assert.deepEqual(classifyTelegramDeliveryError(badRequest,1),{status:'failed',delaySeconds:0,errorLabel:'telegram_http_4xx'});
  assert.deepEqual(classifyTelegramDeliveryError(server,1),{status:'uncertain',delaySeconds:0,errorLabel:'telegram_http_5xx'});
  assert.deepEqual(classifyTelegramDeliveryError(network,1),{status:'uncertain',delaySeconds:0,errorLabel:'network_or_unknown'});
  for(const error of [tooMany,badRequest,server,network]){
    const label=safeTelegramDeliveryErrorLabel(error);
    assert.equal(label.includes('989121234567'),false);
    assert.equal(label.includes('SECRET-123'),false);
  }
});

test('unknown and malformed Telegram errors map to a fixed safe label',()=>{
  assert.equal(safeTelegramDeliveryErrorLabel(new Error('token=do-not-store')), 'network_or_unknown');
  assert.equal(safeTelegramDeliveryErrorLabel({response:{error_code:9999,description:'private data'}}), 'network_or_unknown');
});


test('admin outbox presentation preserves the safe HTTP 408 uncertainty label',()=>{
  const admin=readFileSync(new URL('../../src/bot/handlers/admin.handler.js',import.meta.url),'utf8');
  assert.match(admin,/telegram_http_408_timeout/);
  assert.match(admin,/Delivery outcome unknown after worker lease expired/);
});
