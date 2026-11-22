import test from 'node:test';
import assert from 'node:assert/strict';
import {paymentQuantityKeyboard} from '../../src/bot/handlers/payment.handler.js';

const callbacks=keyboard=>keyboard.reply_markup.inline_keyboard.flat().map(button=>button.callback_data);

test('quantity keyboard starts at one code by default',()=>{
  const keyboard=paymentQuantityKeyboard(41,5,150000,0);
  const data=callbacks(keyboard);
  assert.deepEqual(data.filter(x=>x.startsWith('payment:quantity:')), [
    'payment:quantity:41:1',
    'payment:quantity:41:2',
    'payment:quantity:41:3',
    'payment:quantity:41:4',
    'payment:quantity:41:5'
  ]);
});

test('quantity pagination uses a stable minimum and does not duplicate or skip quantities',()=>{
  const first=paymentQuantityKeyboard(41,12,150000,0,1);
  const second=paymentQuantityKeyboard(41,12,150000,1,1);
  const firstQuantities=callbacks(first).filter(x=>x.startsWith('payment:quantity:')).map(x=>Number(x.split(':').at(-1)));
  const secondQuantities=callbacks(second).filter(x=>x.startsWith('payment:quantity:')).map(x=>Number(x.split(':').at(-1)));
  assert.deepEqual(firstQuantities,[1,2,3,4,5,6,7,8,9,10]);
  assert.deepEqual(secondQuantities,[11,12]);
  assert.ok(callbacks(first).includes('payment:quantity-page:41:1'));
  assert.ok(callbacks(second).includes('payment:quantity-page:41:0'));
});
