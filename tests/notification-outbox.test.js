"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createNotificationOutbox}=require("../src/notification-outbox");

function fakeDb(rows=[],{heartbeatFailure=false}={}){
 const state={rows:rows.map((x,i)=>({id:i+1,status:"pending",attempts:0,payload:x}))};
 const db={state,
  async getConnection(){return {
   async beginTransaction(){},async commit(){},async rollback(){},release(){},
   async execute(sql,params){
    if(sql.includes("UPDATE telegram_notification_outbox SET status=IF(attempts>=?,'failed','pending')"))return [{affectedRows:0}];
    if(sql.includes("UPDATE telegram_notification_outbox SET status='processing'")){const row=state.rows.find(x=>x.id===params[1]);if(row&&row.status==="pending"){row.status="processing";row.attempts++;row.token=params[0];}return [{affectedRows:row?1:0}];}
    throw new Error("Unexpected connection SQL: "+sql);
   },
   async query(sql){if(sql.includes("SELECT id,payload FROM telegram_notification_outbox")){const row=state.rows.find(x=>x.status==="pending");return [row?[{id:row.id,payload:row.payload,notification_type:row.notification_type}]:[]];}throw new Error("Unexpected connection query: "+sql);}
  };},
  async execute(sql,params){
   if(sql.includes("SET processing_started_at=NOW()")){
    if(heartbeatFailure)throw new Error("simulated outbox heartbeat failure");
    return [{affectedRows:1}];
   }
   if(sql.includes("SET status='sent'")){const row=state.rows.find(x=>x.id===params[0]);if(row&&row.status==="processing"&&row.token===params[1]){row.status="sent";return [{affectedRows:1}];}return [{affectedRows:0}];}
   if(sql.includes("SET status=IF(attempts>=?,'failed','pending')")){const row=state.rows.find(x=>x.id===params[3]);if(row&&row.status==="processing"&&row.token===params[4]){row.status=row.attempts>=params[0]?"failed":"pending";row.error=params[2];row.nextAttemptScheduled=row.status==="pending";}return [{affectedRows:1}];}
   throw new Error("Unexpected DB SQL: "+sql);
  }
 };
 return db;
}

test("outbox claims a pending notification and marks it sent after delivery",async()=>{
 const db=fakeDb([{method:"sendMessage",payload:{chat_id:"1",text:"ok"}}]);let sent=0;
 const worker=createNotificationOutbox({db,send:async(method,payload)=>{assert.equal(method,"sendMessage");assert.equal(payload.chat_id,"1");sent++;},logger:{error(){}}});
 assert.equal(await worker.processOne(),true);assert.equal(sent,1);assert.equal(db.state.rows[0].status,"sent");
 assert.equal(await worker.processOne(),false);assert.equal(sent,1);
});

test("outbox returns failed delivery to pending for retry",async()=>{
 const db=fakeDb([{method:"sendMessage",payload:{chat_id:"1"}}]);let calls=0;
 const worker=createNotificationOutbox({db,send:async()=>{calls++;throw new Error("Telegram unavailable");},logger:{error(){}}});
 assert.equal(await worker.processOne(),false);assert.equal(calls,1);assert.equal(db.state.rows[0].status,"pending");assert.equal(db.state.rows[0].error,"Telegram unavailable");assert.equal(db.state.rows[0].nextAttemptScheduled,true);
});


test("outbox lease heartbeat prevents finalization after lease ownership is lost",async()=>{
 const db=fakeDb([{method:"sendMessage",payload:{chat_id:"1"}}],{heartbeatFailure:true});
 const logs=[];
 const worker=createNotificationOutbox({
  db,heartbeatMs:5,
  send:async()=>{await new Promise(resolve=>setTimeout(resolve,25));},
  logger:{error(...args){logs.push(args.join(" "));}}
 });
 assert.equal(await worker.processOne(),false);
 assert.equal(db.state.rows[0].status,"pending");
 assert.ok(logs.some(line=>line.includes("simulated outbox heartbeat failure")));
 assert.ok(logs.some(line=>line.includes("lease was lost")));
});


test("outbox invokes post-delivery hook with durable item identity",async()=>{
 const db=fakeDb([{method:"sendMessage",payload:{chat_id:"1",text:"payment"}}]);
 db.state.rows[0].notification_type="payment_instructions";
 let recorded=null;
 const worker=createNotificationOutbox({
  db,send:async()=>{},
  onSent:async item=>{recorded=item;},
  logger:{error(){}}
 });
 assert.equal(await worker.processOne(),true);
 assert.equal(recorded.id,1);
 assert.equal(recorded.notificationType,"payment_instructions");
 assert.equal(db.state.rows[0].status,"sent");
});
