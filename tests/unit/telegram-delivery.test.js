import test from 'node:test';
import assert from 'node:assert/strict';
import {deliverTelegramNotification} from '../../src/modules/notifications/telegram-delivery.js';

test('photo notifications send the receipt photo with caption and inline actions',async()=>{
  let call;
  const telegram={sendPhoto:async(...args)=>{call=args;return {ok:true};}};
  await deliverTelegramNotification(telegram,'123',{photo:'telegram-file-id',caption:'رسید #3 | سفارش #1',options:{reply_markup:{inline_keyboard:[[{text:'تأیید',callback_data:'payment:approve:3'}]]}}});
  assert.equal(call[0],'123');
  assert.equal(call[1],'telegram-file-id');
  assert.equal(call[2].caption,'رسید #3 | سفارش #1');
  assert.equal(call[2].reply_markup.inline_keyboard[0][0].callback_data,'payment:approve:3');
});

test('legacy text notifications continue to use sendMessage',async()=>{
  let call;
  const telegram={sendMessage:async(...args)=>{call=args;return {ok:true};}};
  await deliverTelegramNotification(telegram,'456',{text:'hello',options:{disable_notification:true}});
  assert.deepEqual(call,['456','hello',{disable_notification:true}]);
});

test('photo notifications reject empty or overlong captions',async()=>{
  const telegram={sendPhoto:async()=>{throw new Error('should not send');}};
  await assert.rejects(deliverTelegramNotification(telegram,'123',{photo:'file',caption:' '}),/caption is required/);
  await assert.rejects(deliverTelegramNotification(telegram,'123',{photo:'file',caption:'x'.repeat(1025)}),/1024/);
});
