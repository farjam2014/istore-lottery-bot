'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {normalizeCardNumber,maskCard,createBankCardService}=require('../src/bank-card-service');

test('normalizes Persian and Arabic digits and masks card numbers',()=>{
  assert.equal(normalizeCardNumber('۶۰۳۷-۹۹۱۸ ۱۲۳۴ ۵۶۷۸'),'6037991812345678');
  assert.equal(normalizeCardNumber('٦٠٣٧ ٩٩١٨ ١٢٣٤ ٥٦٧٨'),'6037991812345678');
  assert.equal(maskCard('6037991812345678'),'•••• •••• •••• 5678');
});

test('rejects invalid card numbers before writing to database',async()=>{
  let writes=0;
  const service=createBankCardService({db:{async execute(){writes++;return [{insertId:1}];}},adminId:'admin'});
  await assert.rejects(service.addCard({label:'Main',cardNumber:'1234',cardholderName:'Test'}),/۱۶ رقم/);
  assert.equal(writes,0);
});

test('adds valid cards using normalized digits and parameterized SQL',async()=>{
  let call;
  const service=createBankCardService({db:{async execute(sql,params){call={sql,params};return [{insertId:9}];}},adminId:'admin'});
  const result=await service.addCard({label:'کارت اصلی',bankName:'بانک',cardNumber:'۶۰۳۷ ۹۹۱۸ ۱۲۳۴ ۵۶۷۸',cardholderName:'علی رضایی'});
  assert.deepEqual(result,{id:9});
  assert.match(call.sql,/INSERT INTO bank_cards/);
  assert.equal(call.params[2],'6037991812345678');
  assert.equal(call.params[4],'admin');
});


test('delivery history returns outbox linkage and masked card snapshot fields',async()=>{
  let call;
  const expected=[{id:3,order_id:7,outbox_id:19,card_id:2,card_label_snapshot:'کارت اصلی',bank_name_snapshot:'ملت',last4:'5678',cardholder_name_snapshot:'علی رضایی',sent_at:'2026-11-14 12:00:00'}];
  const service=createBankCardService({db:{async execute(sql,params){call={sql,params};return [expected];}},adminId:'admin'});
  const rows=await service.deliveries(7);
  assert.deepEqual(rows,expected);
  assert.match(call.sql,/outbox_id/);
  assert.match(call.sql,/cardholder_name_snapshot/);
  assert.deepEqual(call.params,[7]);
});
