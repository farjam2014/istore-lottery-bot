import test from 'node:test';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {registerPaymentHandlers,userOrdersKeyboard,userOrderDetailKeyboard,isStalePaymentReceiptUpdate} from '../../src/bot/handlers/payment.handler.js';
import {registerUserHandlers} from '../../src/bot/handlers/user.handler.js';
import {registerAdminHandlers} from '../../src/bot/handlers/admin.handler.js';

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

test('user support cancellation callback is registered',()=>{
  const actions=[];
  const bot={action:(pattern,handler)=>actions.push(pattern),on:()=>{},command:()=>{}};
  registerUserHandlers(bot);
  assert.ok(actions.includes('support:user:cancel'));
});

test('admin campaign edit cancellation callback is registered with numeric ID',()=>{
  const actions=[];
  const bot={action:(pattern,handler)=>actions.push(pattern),on:()=>{},command:()=>{}};
  registerAdminHandlers(bot);
  const cancel=actions.find(pattern=>pattern instanceof RegExp&&pattern.source.includes('admin:campaign:edit:cancel'));
  assert.ok(cancel);
  assert.ok(cancel.test('admin:campaign:edit:cancel:42'));
});

test('participant block callback enforces participant.manage permission',()=>{
  const source=readFileSync(new URL('../../src/bot/handlers/admin.handler.js',import.meta.url),'utf8');
  assert.match(source,/admin:participant:\(block\|unblock\).*hasPermission\(ctx\.from\.id,'participant\.manage'\)/s);
});

test('handler callback regexes do not contain double-escaped digit tokens',()=>{
  for(const path of ['src/bot/handlers/user.handler.js','src/bot/handlers/payment.handler.js','src/bot/handlers/admin.handler.js']){
    const source=readFileSync(new URL('../../'+path,import.meta.url),'utf8');
    assert.doesNotMatch(source,/\\\\d\+/,{message:path+' contains a double-escaped digit regex'});
  }
});

test('payment receipt replay cursor rejects equal and older updates but allows newer uploads',()=>{
  assert.equal(isStalePaymentReceiptUpdate(100,100),true);
  assert.equal(isStalePaymentReceiptUpdate(99,100),true);
  assert.equal(isStalePaymentReceiptUpdate(101,100),false);
  assert.equal(isStalePaymentReceiptUpdate(101,null),false);
  assert.equal(isStalePaymentReceiptUpdate('invalid',null),true);
  assert.equal(isStalePaymentReceiptUpdate(101,'invalid'),true);
});

test('payment receipt sessions persist the callback update cursor and claim photo updates atomically',()=>{
  const source=readFileSync(new URL('../../src/bot/handlers/payment.handler.js',import.meta.url),'utf8');
  assert.equal((source.match(/last_update_id\) VALUES\(\?,'awaiting_payment_receipt'/g)||[]).length,2);
  assert.match(source,/UPDATE telegram_user_sessions SET last_update_id=\? WHERE telegram_user_id=\? AND step='awaiting_payment_receipt'/);
  assert.match(source,/JSON_UNQUOTE\(JSON_EXTRACT\(payload,'\$\.orderId'\)\)=\?/);
});

test('payment cancellation is bound to the order shown on its button',()=>{
  const actions=[];
  const bot={action:(pattern,handler)=>actions.push(pattern),on:()=>{},command:()=>{}};
  registerPaymentHandlers(bot);
  const cancel=actions.find(pattern=>pattern instanceof RegExp&&pattern.source.includes('payment:cancel'));
  assert.ok(cancel);
  assert.ok(cancel.test('payment:cancel:123'));
  assert.ok(!cancel.test('payment:cancel:456x'));
});
