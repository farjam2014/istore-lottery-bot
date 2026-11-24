import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCardNumber,createPaymentCard,updatePaymentCard} from '../../src/modules/payments/bank-card.service.js';

test('card number normalization removes spaces and hyphens',()=>{
  assert.equal(normalizeCardNumber('4111 1111-2222 3333'),'4111111122223333');
});

test('card number normalization rejects non-16-digit values',()=>{
  for(const value of ['', '123456789012345', '12345678901234567', '1234-5678-9012-abcd']){
    assert.throws(()=>normalizeCardNumber(value),/دقیقاً ۱۶ رقم/);
  }
});

test('card number normalization rejects nullish values',()=>{
  assert.throws(()=>normalizeCardNumber(null),/دقیقاً ۱۶ رقم/);
  assert.throws(()=>normalizeCardNumber(undefined),/دقیقاً ۱۶ رقم/);
});

function fakeDatabase({auditFails=false}={}){
  const state={calls:[],commits:0,rollbacks:0,releases:0};
  const connection={
    async beginTransaction(){state.calls.push('begin');},
    async commit(){state.calls.push('commit');state.commits++;},
    async rollback(){state.calls.push('rollback');state.rollbacks++;},
    release(){state.releases++;},
    async execute(sql,params=[]){
      state.calls.push(sql);
      if(sql.startsWith('SELECT id FROM payment_bank_cards ORDER BY id FOR UPDATE'))return [[],[]];
      if(sql.startsWith('INSERT INTO payment_bank_cards'))return [{insertId:7},[]];
      if(sql.startsWith('INSERT INTO admin_audit_log')){
        if(auditFails)throw new Error('audit unavailable');
        state.auditParams=params;return [{insertId:1},[]];
      }
      throw new Error('Unexpected SQL: '+sql);
    }
  };
  return {state,async getConnection(){return connection;}};
}

test('bank card creation and audit are committed in the same transaction',async()=>{
  const {createPaymentCard}=await import('../../src/modules/payments/bank-card.service.js');
  const database=fakeDatabase();
  const result=await createPaymentCard({bankName:'Test Bank',cardNumber:'4111111111111111',cardHolder:'Test Holder'},'99999',{database});
  assert.deepEqual(result,{id:7,default:true});
  assert.equal(database.state.commits,1);
  assert.equal(database.state.rollbacks,0);
  assert.ok(database.state.calls.indexOf(database.state.calls.find(x=>String(x).startsWith('INSERT INTO admin_audit_log')))<database.state.calls.indexOf('commit'));
  assert.deepEqual(database.state.auditParams.slice(2,5),['payment_card.created','payment_bank_card',7]);
});

test('bank card creation rolls back when its audit insert fails',async()=>{
  const {createPaymentCard}=await import('../../src/modules/payments/bank-card.service.js');
  const database=fakeDatabase({auditFails:true});
  await assert.rejects(createPaymentCard({bankName:'Test Bank',cardNumber:'4111111111111111',cardHolder:'Test Holder'},'99999',{database}),/audit unavailable/);
  assert.equal(database.state.commits,0);
  assert.equal(database.state.rollbacks,1);
  assert.equal(database.state.releases,1);
});

function fakeDatabase({auditFails=false}={}){
  const state={commits:0,rollbacks:0,releases:0,audits:0,updates:0};
  const connection={
    async beginTransaction(){},
    async commit(){state.commits++;},
    async rollback(){state.rollbacks++;},
    release(){state.releases++;},
    async execute(sql,params=[]){
      if(sql.startsWith('SELECT id FROM payment_bank_cards ORDER BY id FOR UPDATE'))return [[],[]];
      if(sql.startsWith('SELECT id FROM payment_bank_cards WHERE id=? FOR UPDATE'))return [[{id:params[0]}],[]];
      if(sql.startsWith('INSERT INTO payment_bank_cards'))return [{insertId:5},[]];
      if(sql.startsWith('UPDATE payment_bank_cards SET bank_name=')){state.updates++;return [{affectedRows:1},[]];}
      if(sql.startsWith('INSERT INTO admin_audit_log')){state.audits++;if(auditFails)throw new Error('audit unavailable');return [{affectedRows:1},[]];}
      throw new Error('Unexpected SQL '+sql);
    }
  };
  return {state,async getConnection(){return connection;},async execute(sql,params=[]){
    if(sql.startsWith('SELECT id,bank_name,card_number,card_holder,instructions,is_active,is_default FROM payment_bank_cards WHERE id=?'))return [[{id:params[0],bank_name:'Test Bank',card_number:'4111111111111111',card_holder:'Test Holder',instructions:null,is_active:1,is_default:1}],[]];
    throw new Error('Unexpected pool SQL '+sql);
  }};
}

const validCard={bankName:'Test Bank',cardNumber:'4111111111111111',cardHolder:'Test Holder',instructions:''};

test('creating a payment card writes audit in the same transaction',async()=>{
  const database=fakeDatabase();
  const result=await createPaymentCard(validCard,'12345',{database});
  assert.deepEqual(result,{id:5,default:true});
  assert.equal(database.state.audits,1);
  assert.equal(database.state.commits,1);
  assert.equal(database.state.rollbacks,0);
});

test('creating a payment card rolls back when audit insertion fails',async()=>{
  const database=fakeDatabase({auditFails:true});
  await assert.rejects(createPaymentCard(validCard,'12345',{database}),/audit unavailable/);
  assert.equal(database.state.audits,1);
  assert.equal(database.state.commits,0);
  assert.equal(database.state.rollbacks,1);
});

test('updating a payment card writes audit before commit',async()=>{
  const database=fakeDatabase();
  const result=await updatePaymentCard(5,validCard,'12345',{database});
  assert.equal(result.id,5);
  assert.equal(database.state.updates,1);
  assert.equal(database.state.audits,1);
  assert.equal(database.state.commits,1);
});

test('updating a payment card rolls back when audit insertion fails',async()=>{
  const database=fakeDatabase({auditFails:true});
  await assert.rejects(updatePaymentCard(5,validCard,'12345',{database}),/audit unavailable/);
  assert.equal(database.state.updates,1);
  assert.equal(database.state.audits,1);
  assert.equal(database.state.commits,0);
  assert.equal(database.state.rollbacks,1);
});
