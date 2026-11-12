"use strict";
const crypto=require("node:crypto");

function createNotificationOutbox({db,send,logger=console,pollInterval=1000,leaseMs=60000,maxAttempts=5}){
 if(!db||typeof send!=="function")throw new Error("db and send are required");
 let busy=false,timer=null;
 async function processOne(){
  if(busy)return false; busy=true; let item=null;
  try{
   const conn=await db.getConnection();
   try{
    await conn.beginTransaction();
    await conn.execute("UPDATE telegram_notification_outbox SET status=IF(attempts>=?,'failed','pending'),processing_started_at=NULL,processing_token=NULL,last_error='Processing lease expired; reclaimed' WHERE status='processing' AND processing_started_at < DATE_SUB(NOW(),INTERVAL ? MICROSECOND)",[maxAttempts,leaseMs*1000]);
    const [rows]=await conn.query("SELECT id,payload FROM telegram_notification_outbox WHERE status='pending' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED");
    if(!rows.length){await conn.commit();return false;}
    item=rows[0];item.token=crypto.randomUUID();
    await conn.execute("UPDATE telegram_notification_outbox SET status='processing',attempts=attempts+1,processing_started_at=NOW(),processing_token=? WHERE id=? AND status='pending'",[item.token,item.id]);
    await conn.commit();
   }catch(e){await conn.rollback();throw e;}finally{conn.release();}
   const data=typeof item.payload==="string"?JSON.parse(item.payload):item.payload;
   await send(data.method,data.payload);
   const [result]=await db.execute("UPDATE telegram_notification_outbox SET status='sent',sent_at=NOW(),processing_started_at=NULL,processing_token=NULL,last_error=NULL WHERE id=? AND status='processing' AND processing_token=?",[item.id,item.token]);
   if(result.affectedRows!==1)throw new Error("Outbox claim was lost after Telegram send; delivery may be duplicated on retry");
   return true;
  }catch(e){
   logger.error("Notification outbox error:",e.message);
   if(item?.token)await db.execute("UPDATE telegram_notification_outbox SET status=IF(attempts>=?,'failed','pending'),processing_started_at=NULL,processing_token=NULL,last_error=? WHERE id=? AND status='processing' AND processing_token=?",[maxAttempts,String(e.message||"Unknown error").slice(0,500),item.id,item.token]).catch(x=>logger.error("Outbox retry update error:",x.message));
   return false;
  }finally{busy=false;}
 }
 function start(){if(timer)return;timer=setInterval(()=>processOne().catch(e=>logger.error("Outbox worker error:",e.message)),pollInterval);timer.unref?.();}
 function stop(){if(timer)clearInterval(timer);timer=null;}
 return {processOne,start,stop};
}
module.exports={createNotificationOutbox};
