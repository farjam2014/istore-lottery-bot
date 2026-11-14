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
 assert.ok(calls.some(x=>typeof x==='object'&&x.sql.includes('received_at=DATE_ADD(NOW(3)')));
 assert.ok(calls.some(x=>typeof x==='object'&&x.sql.includes('INSERT INTO webhook_rate_limit_events')));
 assert.ok(!calls.some(x=>typeof x==='object'&&x.sql.includes('attempts=attempts+1')));
 assert.ok(calls.includes('commit'));
});

test('deferred webhook is rate-checked again until the quota window permits handling',async()=>{
 const calls=[];
 let deferred=false,rateCalls=0,handled=0;
 const item={update_id:'7002',correlation_id:'123e4567-e89b-42d3-a456-426614174001',payload:{business_message:{from:{id:123457},text:'لاتاری'}}};
 let connections=0;
 const db={
  async getConnection(){connections++;return{
   async beginTransaction(){},
   async commit(){},
   async rollback(){},
   release(){},
   async query(sql){calls.push(sql);return [[item],[]];},
   async execute(sql){
    calls.push(sql);
    if(sql.includes('SELECT retry_after_ms FROM webhook_rate_limit_events'))return [deferred?[{retry_after_ms:5000}]:[],[]];
    if(sql.includes('INSERT INTO webhook_rate_limit_events')){deferred=true;return [{affectedRows:1},[]];}
    if(sql.includes('DELETE FROM webhook_rate_limit_events')){deferred=false;return [{affectedRows:1},[]];}
    if(sql.includes("status='done'"))return [{affectedRows:1},[]];
    return [{affectedRows:1},[]];
   }
  };},
  async execute(sql){calls.push(sql);if(sql.includes('SELECT 1 FROM processed_updates'))return [[],[]];return [{affectedRows:1},[]];}
 };
 const decisions=[{limited:true,retryAfterMs:5000},{limited:true,retryAfterMs:5000},{limited:false,retryAfterMs:0}];
 const queue=createWebhookQueue({db,handlers:{business:async()=>{handled++;}},rateLimit:async()=>{rateCalls++;return decisions.shift();},logger:{error(){}}});
 assert.equal(await queue.processOne(),false);
 assert.equal(await queue.processOne(),false);
 assert.equal(await queue.processOne(),true);
 assert.equal(rateCalls,3,'every deferred update must be rechecked against the active window');
 assert.equal(handled,1);
 assert.equal(deferred,false,'defer marker must be removed after the update becomes eligible');
 assert.ok(calls.some(sql=>sql.includes('DELETE FROM webhook_rate_limit_events')));
});
