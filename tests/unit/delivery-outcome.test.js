import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyTelegramDeliveryError} from '../../src/modules/notifications/delivery-outcome.js';

test('network errors without a definitive Telegram response are uncertain',()=>{
  assert.deepEqual(classifyTelegramDeliveryError(new Error('socket hang up')),{kind:'uncertain',reason:'no-definitive-telegram-response'});
});

test('Telegram server errors and request timeouts are uncertain and must not be auto-retried',()=>{
  assert.deepEqual(classifyTelegramDeliveryError({response:{error_code:500}}),{kind:'uncertain',reason:'ambiguous-server-response',errorCode:500});
  assert.deepEqual(classifyTelegramDeliveryError({response:{error_code:408}}),{kind:'uncertain',reason:'ambiguous-server-response',errorCode:408});
});

test('Telegram 429 responses are safely retryable using retry_after',()=>{
  assert.deepEqual(classifyTelegramDeliveryError({response:{error_code:429,parameters:{retry_after:27}}}),{kind:'retry',retryAfterSeconds:27});
  assert.deepEqual(classifyTelegramDeliveryError({response:{error_code:429,parameters:{retry_after:7200}}}),{kind:'retry',retryAfterSeconds:3600});
  assert.deepEqual(classifyTelegramDeliveryError({response:{error_code:429}}),{kind:'retry',retryAfterSeconds:null});
});

test('definitive Telegram 4xx rejections are permanent failures',()=>{
  assert.deepEqual(classifyTelegramDeliveryError({response:{error_code:400}}),{kind:'permanent',errorCode:400});
  assert.deepEqual(classifyTelegramDeliveryError({response:{error_code:403}}),{kind:'permanent',errorCode:403});
});
