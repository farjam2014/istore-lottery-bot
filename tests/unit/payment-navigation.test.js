import test from 'node:test';
import assert from 'node:assert/strict';
import {registerPaymentHandlers,userOrdersKeyboard,userOrderDetailKeyboard} from '../../src/bot/handlers/payment.handler.js';

const callbacks=keyboard=>keyboard.reply_markup.inline_keyboard.flat().map(button=>button.callback_data);

test('order list keyboard uses one compact button per order and pagination',()=>{
  const rows=Array.from({length:8},(_,i)=>({id:i+1,status:i===0?'rejected':'under_review',campaign_title:'Campaign '+(i+1),requested_code_count:2}));
  const first=userOrdersKeyboard(rows,0,10,8);
  assert.equal(first.visible.length,8);
  const data=callbacks(first.keyboard);
  assert.ok(data.includes('payment:order:1'));
  assert.ok(data.includes('payment:order:8'));
  assert.ok(data.includes('user:orders:page:1'));
  assert.ok(data.includes('user:home'));
  assert.equal(data.filter(x=>x.startsWith('payment:order:')).length,8);
});

test('last order page does not expose next-page callback',()=>{
  const rows=[{id:9,status:'approved',campaign_title:'Campaign',requested_code_count:1}];
  const last=userOrdersKeyboard(rows,1,9,8);
  assert.equal(last.visible.length,1);
  const data=callbacks(last.keyboard);
  assert.ok(data.includes('user:orders:page:0'));
  assert.ok(!data.includes('user:orders:page:2'));
});

test('order detail actions depend on order state',()=>{
  const awaiting=callbacks(userOrderDetailKeyboard({id:5,status:'awaiting_receipt'}));
  assert.ok(awaiting.includes('payment:resume:5'));
  const rejected=callbacks(userOrderDetailKeyboard({id:6,status:'rejected'}));
  assert.ok(rejected.includes('payment:resume:6'));
  const approved=callbacks(userOrderDetailKeyboard({id:7,status:'approved'}));
  assert.ok(approved.includes('user:codes'));
  assert.ok(!approved.includes('payment:resume:7'));
  for(const data of [awaiting,rejected,approved]){
    assert.ok(data.includes('user:orders'));
    assert.ok(data.includes('user:home'));
  }
});

test('payment navigation callback patterns accept numeric IDs and pages',()=>{
  const actions=[];
  const bot={action:(pattern,handler)=>actions.push(pattern),on:()=>{},command:()=>{}};
  registerPaymentHandlers(bot);
  const page=actions.find(pattern=>pattern instanceof RegExp&&pattern.source.includes('user:orders:page'));
  const order=actions.find(pattern=>pattern instanceof RegExp&&pattern.source.includes('payment:order'));
  assert.ok(page,'orders pagination callback is registered');
  assert.ok(order,'order detail callback is registered');
  assert.ok(page.test('user:orders:page:2'));
  assert.ok(order.test('payment:order:123'));
});
