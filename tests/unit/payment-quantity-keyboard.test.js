import test from 'node:test';
import assert from 'node:assert/strict';
import {paymentQuantityKeyboard} from '../../src/bot/handlers/payment.handler.js';

const callbacks=keyboard=>keyboard.reply_markup.inline_keyboard.flat().map(button=>button.callback_data);

test('more-codes keyboard starts at two and excludes the one-code choice',()=>{
  const keyboard=paymentQuantityKeyboard(41,5,150000,0,2);
  const data=callbacks(keyboard);
  assert.deepEqual(data.filter(x=>x.startsWith('payment:quantity:')),[
    'payment:quantity:41:2',
    'payment:quantity:41:3',
    'payment:quantity:41:4',
    'payment:quantity:41:5'
  ]);
  assert.ok(!data.includes('payment:quantity:41:1'));
});

test('quantity pagination uses a stable minimum and does not duplicate or skip quantities',()=>{
  const first=paymentQuantityKeyboard(41,12,150000,0,2);
  const second=paymentQuantityKeyboard(41,12,150000,1,2);
  const firstQuantities=callbacks(first).filter(x=>x.startsWith('payment:quantity:')).map(x=>Number(x.split(':').at(-1)));
  const secondQuantities=callbacks(second).filter(x=>x.startsWith('payment:quantity:')).map(x=>Number(x.split(':').at(-1)));
  assert.deepEqual(firstQuantities,[2,3,4,5,6,7,8,9,10,11]);
  assert.deepEqual(secondQuantities,[12]);
  assert.ok(callbacks(first).includes('payment:quantity-page:41:1'));
  assert.ok(callbacks(second).includes('payment:quantity-page:41:0'));
});
