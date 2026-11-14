'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {consumeTelegramRateLimit,identifyTelegramActor,rateLimitBucket}=require('../src/telegram-rate-limit');

function fakeDb({deadlocks=0}={}){
 const rows=new Map();
 return {rows,async getConnection(){return{
  async beginTransaction(){},async commit(){},async rollback(){},release(){},
  async execute(sql,p=[]){
   if(sql.startsWith('INSERT IGNORE INTO telegram_rate_limits')){const key=p[0]+':'+p[1];if(!rows.has(key))rows.set(key,{window_started_at:Date.now(),request_count:0,blocked_until:0});return [{affectedRows:1}];}
   if(sql.startsWith('SELECT window_started_at')){if(deadlocks>0){deadlocks--;const error=new Error('simulated deadlock');error.code='ER_LOCK_DEADLOCK';throw error;}const key=p[1]+':'+p[2],r=rows.get(key);const expired=Date.now()-r.window_started_at>=p[0]/1000;return [[{window_started_at:r.window_started_at,request_count:r.request_count,is_blocked:r.blocked_until>Date.now()?1:0,retry_us:Math.max(0,r.blocked_until-Date.now())*1000,window_expired:expired?1:0}]];}
   if(sql.startsWith('UPDATE telegram_rate_limits SET window_started_at')){const r=rows.get(p[0]+':'+p[1]);r.window_started_at=Date.now();r.request_count=1;r.blocked_until=0;return [{affectedRows:1}];}
   if(sql.startsWith('UPDATE telegram_rate_limits SET blocked_until')){const r=rows.get(p[1]+':'+p[2]);r.blocked_until=Date.now()+p[0]/1000;return [{affectedRows:1}];}
   if(sql.startsWith('UPDATE telegram_rate_limits SET request_count')){const r=rows.get(p[0]+':'+p[1]);r.request_count++;return [{affectedRows:1}];}
   throw new Error('Unexpected SQL '+sql);
  }
 }};}
test('rate limit is per Telegram actor and bucket and blocks after configured quota',async()=>{
 const db=fakeDb();
 assert.equal((await consumeTelegramRateLimit(db,{userId:'100',limit:2,windowMs:60000})).allowed,true);
 assert.equal((await consumeTelegramRateLimit(db,{userId:'100',limit:2,windowMs:60000})).allowed,true);
 const denied=await consumeTelegramRateLimit(db,{userId:'100',limit:2,windowMs:60000});
 assert.equal(denied.allowed,false);assert.equal(denied.limited,true);assert.ok(denied.retryAfterMs>0);
 assert.equal((await consumeTelegramRateLimit(db,{userId:'101',limit:2,windowMs:60000})).allowed,true);
 assert.equal((await consumeTelegramRateLimit(db,{userId:'100',bucket:'callback',limit:1})).allowed,true);
});
test('rate limit resets after its time window expires',async()=>{
 const db=fakeDb();
 await consumeTelegramRateLimit(db,{userId:'200',limit:1,windowMs:100});
 assert.equal((await consumeTelegramRateLimit(db,{userId:'200',limit:1,windowMs:100})).allowed,false);
 await new Promise(r=>setTimeout(r,120));
 assert.equal((await consumeTelegramRateLimit(db,{userId:'200',limit:1,windowMs:100})).allowed,true);
});
test('extracts actor and separates callback traffic from messages',()=>{
 assert.equal(identifyTelegramActor({business_message:{from:{id:42}}}),'42');
 assert.equal(identifyTelegramActor({callback_query:{from:{id:43}}}),'43');
 assert.equal(rateLimitBucket({callback_query:{id:'x'}}),'callback');
 assert.equal(rateLimitBucket({message:{message_id:1}}),'message');
 assert.equal(identifyTelegramActor({channel_post:{chat:{id:1}}}),null);
});

test('rate limiter retries a transient MySQL deadlock on an owned transaction',async()=>{
 const db=fakeDb({deadlocks:1});
 const result=await consumeTelegramRateLimit(db,{userId:'300',limit:2,windowMs:60000});
 assert.equal(result.allowed,true);
 assert.equal(db.rows.get('300:message').request_count,1);
});
