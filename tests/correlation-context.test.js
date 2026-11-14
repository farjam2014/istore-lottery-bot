'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {runWithCorrelation,getCorrelationId,bindPool,injectCorrelation}=require('../src/correlation-context');

test('correlation context propagates across async boundaries and restores after scope',async()=>{
 const id='123e4567-e89b-42d3-a456-426614174000';
 assert.equal(getCorrelationId(),null);
 await runWithCorrelation(id,async()=>{
  await Promise.resolve();
  assert.equal(getCorrelationId(),id);
 });
 assert.equal(getCorrelationId(),null);
});

test('injects correlation id only into supported inserts and never duplicates the column',()=>{
 const id='123e4567-e89b-42d3-a456-426614174000';
 const input='INSERT IGNORE INTO telegram_notification_outbox(dedupe_key,notification_type,payload) VALUES(?,?,?)';
 const result=injectCorrelation(input,['k','t','{}'],id);
 assert.match(result.sql,/payload,correlation_id\) VALUES\(\?,\?,\?,\?\)/);
 assert.deepEqual(result.values,['k','t','{}',id]);
 assert.equal(injectCorrelation(result.sql,result.values,id).sql,result.sql);
 assert.equal(injectCorrelation('INSERT INTO participants(id) VALUES(?)',[1],id).sql,'INSERT INTO participants(id) VALUES(?)');
});

test('correlation injection preserves nested SQL functions and interval expressions',()=>{
 const id='123e4567-e89b-42d3-a456-426614174000';
 const sql='INSERT INTO payment_orders(order_ref,expires_at) VALUES(?,DATE_ADD(NOW(),INTERVAL ? MINUTE))';
 const result=injectCorrelation(sql,['ORDER-1',15],id);
 assert.equal(result.sql,'INSERT INTO payment_orders(order_ref,expires_at,correlation_id) VALUES(?,DATE_ADD(NOW(),INTERVAL ? MINUTE),?)');
 assert.deepEqual(result.values,['ORDER-1',15,id]);
});

test('pool and transaction connections both inherit the current correlation id',async()=>{
 const calls=[];
 const makeConnection=()=>({async execute(sql,values){calls.push({sql,values});return [[],[]];},async query(sql,values){calls.push({sql,values});return [[],[]];}});
 const pool={async execute(sql,values){calls.push({sql,values});return [[],[]];},async query(sql,values){calls.push({sql,values});return [[],[]];},async getConnection(){return makeConnection();}};
 bindPool(pool);
 const id='123e4567-e89b-42d3-a456-426614174000';
 await runWithCorrelation(id,async()=>{
  await pool.execute('INSERT INTO payment_orders(id) VALUES(?)',[1]);
  const conn=await pool.getConnection();
  await conn.execute('INSERT INTO admin_audit_log(admin_id) VALUES(?)',['admin']);
  await conn.query('INSERT INTO telegram_notification_outbox(dedupe_key,notification_type,payload) VALUES(?,?,?)',['k','x','{}']);
 });
 assert.equal(calls.length,3);
 assert.ok(calls.every(x=>x.values.at(-1)===id));
});
