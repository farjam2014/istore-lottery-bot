"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createNotificationOutbox}=require("../src/notification-outbox");

function fakeDb(payloads,{heartbeatFailure=false}={}){
 const state={rows:payloads.map((payload,i)=>({
  id:i+1,status:"pending",attempts:0,payload,notification_type:payload.delivery_card?"payment_instructions":"generic",
  correlation_id:"123e4567-e89b-42d3-a456-426614174000",delivery_recorded_at:null,
  post_delivery_started_at:null,post_delivery_token:null,processing_started_at:null,processing_token:null
 }))};
 const db={state,
  async getConnection(){return{
   async beginTransaction(){},async commit(){},async rollback(){},release(){},
   async execute(sql,params=[]){
    if(sql.includes("UPDATE telegram_notification_outbox SET status='processing'")){
     const row=state.rows.find(x=>x.id===params[1]);
     if(row&&row.status==='pending'){row.status='processing';row.attempts++;row.processing_token=params[0];row.processing_started_at=Date.now();return [{affectedRows:1}];}
     return [{affectedRows:0}];
    }
    if(sql.includes("SET post_delivery_started_at=NOW()")){
     const row=state.rows.find(x=>x.id===params[1]);
     if(row&&row.status==='sent'&&!row.delivery_recorded_at){row.post_delivery_started_at=Date.now();row.post_delivery_token=params[0];return [{affectedRows:1}];}
     return [{affectedRows:0}];
    }
    return [{affectedRows:0}];
   },
   async query(sql){
    if(sql.includes("WHERE status='sent' AND notification_type='payment_instructions'")){
     const row=state.rows.find(x=>x.status==='sent'&&x.notification_type==='payment_instructions'&&!x.delivery_recorded_at&&!x.post_delivery_token);
     return [row?[{id:row.id,payload:row.payload,notification_type:row.notification_type,correlation_id:row.correlation_id}]:[]];
    }
    if(sql.includes("WHERE status='pending'")){
     const row=state.rows.find(x=>x.status==='pending');
     return [row?[{id:row.id,payload:row.payload,notification_type:row.notification_type,correlation_id:row.correlation_id}]:[]];
    }
    throw new Error("Unexpected connection query: "+sql);
   }
  };},
  async execute(sql,params=[]){
   if(sql.includes("SET processing_started_at=NOW()")){
    if(heartbeatFailure)throw new Error("simulated outbox heartbeat failure");
    const row=state.rows.find(x=>x.id===params[0]);
    if(row&&row.status===params[1]&&row.processing_token===params[2]){row.processing_started_at=Date.now();return [{affectedRows:1}];}
    return [{affectedRows:0}];
   }
   if(sql.includes("SET post_delivery_started_at=NOW()")){
    if(heartbeatFailure)throw new Error("simulated outbox heartbeat failure");
    const row=state.rows.find(x=>x.id===params[0]);
    if(row&&row.status===params[1]&&row.post_delivery_token===params[2]){row.post_delivery_started_at=Date.now();return [{affectedRows:1}];}
    return [{affectedRows:0}];
   }
   if(sql.includes("SET status='sent'")){
    const row=state.rows.find(x=>x.id===params[3]);
    if(row&&row.status==='processing'&&row.processing_token===params[4]){
     row.status='sent';row.sent_at=Date.now();row.processing_started_at=null;row.processing_token=null;
     if(params[0]){row.post_delivery_started_at=Date.now();row.post_delivery_token=params[2];}
     return [{affectedRows:1}];
    }
    return [{affectedRows:0}];
   }
   if(sql.includes("SET delivery_recorded_at=NOW()")){
    const row=state.rows.find(x=>x.id===params[0]);
    if(row&&row.status==='sent'&&row.post_delivery_token===params[1]&&!row.delivery_recorded_at){
     row.delivery_recorded_at=Date.now();row.post_delivery_started_at=null;row.post_delivery_token=null;return [{affectedRows:1}];
    }
    return [{affectedRows:0}];
   }
   if(sql.includes("SET post_delivery_started_at=NULL")){
    const row=state.rows.find(x=>x.id===params[1]);
    if(row&&row.status==='sent'&&row.post_delivery_token===params[2]){row.post_delivery_started_at=null;row.post_delivery_token=null;row.error=params[0];}
    return [{affectedRows:1}];
   }
   if(sql.includes("SET status=IF(attempts>=?,'failed','pending')")){
    const row=state.rows.find(x=>x.id===params[3]);
    if(row&&row.status==='processing'&&row.processing_token===params[4]){
     row.status=row.attempts>=params[0]?'failed':'pending';row.processing_started_at=null;row.processing_token=null;row.error=params[2];row.nextAttemptScheduled=row.status==='pending';
    }
    return [{affectedRows:1}];
   }
   throw new Error("Unexpected DB SQL: "+sql);
  }
 };
 return db;
}

test("outbox claims a pending notification and marks it sent after Telegram delivery",async()=>{
 const db=fakeDb([{method:"sendMessage",payload:{chat_id:"1",text:"ok"}}]);let sent=0;
 const worker=createNotificationOutbox({db,send:async(method,payload)=>{assert.equal(method,"sendMessage");assert.equal(payload.chat_id,"1");sent++;},logger:{error(){}}});
 assert.equal(await worker.processOne(),true);assert.equal(sent,1);assert.equal(db.state.rows[0].status,"sent");
 assert.equal(await worker.processOne(),false);assert.equal(sent,1);
});

test("outbox returns failed Telegram delivery to pending with retry metadata",async()=>{
 const db=fakeDb([{method:"sendMessage",payload:{chat_id:"1"}}]);let calls=0;
 const worker=createNotificationOutbox({db,send:async()=>{calls++;throw new Error("Telegram unavailable");},logger:{error(){}}});
 assert.equal(await worker.processOne(),false);assert.equal(calls,1);assert.equal(db.state.rows[0].status,"pending");
 assert.equal(db.state.rows[0].error,"Telegram unavailable");assert.equal(db.state.rows[0].nextAttemptScheduled,true);
});

test("lost processing lease prevents finalization and schedules recovery",async()=>{
 const db=fakeDb([{method:"sendMessage",payload:{chat_id:"1"}}],{heartbeatFailure:true});
 const logs=[];
 const worker=createNotificationOutbox({db,heartbeatMs:5,send:async()=>{await new Promise(r=>setTimeout(r,25));},logger:{error(...x){logs.push(x.join(" "));}}});
 assert.equal(await worker.processOne(),false);
 assert.equal(db.state.rows[0].status,"pending");
 assert.ok(logs.some(x=>x.includes("simulated outbox heartbeat failure")));
 assert.ok(logs.some(x=>x.includes("lease was lost")));
});

test("post-delivery card history failure is retried without sending Telegram twice",async()=>{
 const db=fakeDb([{method:"sendMessage",payload:{chat_id:"1"},delivery_card:{orderId:7,card:{id:2}}}]);
 let sends=0,hooks=0;
 const worker=createNotificationOutbox({
  db,send:async()=>{sends++;},
  onSent:async()=>{hooks++;if(hooks===1)throw new Error("card history database unavailable");},
  logger:{error(){}}
 });
 assert.equal(await worker.processOne(),false);
 assert.equal(db.state.rows[0].status,"sent");
 assert.equal(db.state.rows[0].delivery_recorded_at,null);
 assert.equal(sends,1);
 assert.equal(await worker.processOne(),true);
 assert.equal(sends,1,'recovery must not send the customer message again');
 assert.equal(hooks,2);
 assert.ok(db.state.rows[0].delivery_recorded_at);
 assert.equal(db.state.rows[0].post_delivery_token,null);
});

test("post-delivery hook receives durable outbox and correlation identity",async()=>{
 const db=fakeDb([{method:"sendMessage",payload:{chat_id:"1"},delivery_card:{orderId:7,card:{id:2}}}]);
 let recorded=null;
 const worker=createNotificationOutbox({db,send:async()=>{},onSent:async item=>{recorded=item;},logger:{error(){}}});
 assert.equal(await worker.processOne(),true);
 assert.equal(recorded.id,1);
 assert.equal(recorded.notificationType,"payment_instructions");
 assert.equal(recorded.correlationId,"123e4567-e89b-42d3-a456-426614174000");
 assert.ok(db.state.rows[0].delivery_recorded_at);
});
