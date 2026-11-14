'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createWebhookQueue}=require('../src/webhook-queue');

test('rate-limited Telegram updates are deferred without consuming processing attempts',async()=>{
 const calls=[];
 let handled=0,checked=null;
 const item={update_id:'7001',correlation_id:'123e4567-e89b-42d3-a456-426614174000',payload:{business_message:{from:{id:123456},text:'لاتاری'}}};
 const db={
  async getConnection(){return{
   async beginTransaction(){calls.push('begin');},
   async commit(){calls.push('commit');},
   async rollback(){calls.push('rollback');},
   release(){calls.push('release');},
   async query(sql){calls.push(sql);return [[item],[]];},
   async execute(sql,params){calls.push({sql,params});return [{affectedRows:1},[]];}
  };},
  async execute(){throw new Error('rate-limited updates must not reach handler processing');}
 };
 const queue=createWebhookQueue({
  db,handlers:{business:async()=>{handled++;}},
  rateLimit:async(_db,options)=>{checked=options;return {limited:true,retryAfterMs:5000};},
  logger:{error(){}}
 });
 assert.equal(await queue.processOne(),false);
 assert.equal(handled,0);
 assert.equal(checked.userId,'123456');
 assert.equal(checked.bucket,'message');
 assert.ok(calls.some(x=>typeof x==='object'&&x.sql.includes('received_at=DATE_ADD(UTC_TIMESTAMP(3)')));
 assert.ok(calls.some(x=>typeof x==='object'&&x.sql.includes('INSERT IGNORE INTO webhook_rate_limit_events')));
 assert.ok(!calls.some(x=>typeof x==='object'&&x.sql.includes('attempts=attempts+1')));
 assert.ok(calls.includes('commit'));
});
