"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createNotificationOutbox}=require("../src/notification-outbox");

function fakeDb(rows=[]){
 const state={rows:rows.map((x,i)=>({id:i+1,status:"pending",attempts:0,payload:x}))};
 const db={state,
  async getConnection(){return {
   async beginTransaction(){},async commit(){},async rollback(){},release(){},
   async execute(sql,params){
    if(sql.includes("UPDATE telegram_notification_outbox SET status=IF(attempts>=?,'failed','pending')"))return [{affectedRows:0}];
    if(sql.includes("UPDATE telegram_notification_outbox SET status='processing'")){const row=state.rows.find(x=>x.id===params[1]);if(row&&row.status==="pending"){row.status="processing";row.attempts++;row.token=params[0];}return [{affectedRows:row?1:0}];}
    throw new Error("Unexpected connection SQL: "+sql);
   },
   async query(sql){if(sql.includes("SELECT id,payload FROM telegram_notification_outbox")){const row=state.rows.find(x=>x.status==="pending");return [row?[{id:row.id,payload:row.payload}]:[]];}throw new Error("Unexpected connection query: "+sql);}
  };},
  async execute(sql,params){
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
