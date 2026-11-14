"use strict";
const crypto=require("node:crypto");
const {runWithCorrelation}=require("./correlation-context");
function createNotificationOutbox({db,send,onSent=null,logger=console,pollInterval=1000,leaseMs=60000,heartbeatMs=Math.max(100,Math.floor(leaseMs/3)),maxAttempts=5}){
 if(!db||typeof send!=="function")throw new Error("db and send are required");
 let busy=false,timer=null;
 async function claim(){
  const conn=await db.getConnection();
  try{
   await conn.beginTransaction();
   await conn.execute("UPDATE telegram_notification_outbox SET status=IF(attempts>=?,'failed','pending'),next_attempt_at=IF(attempts>=?,NULL,DATE_ADD(NOW(),INTERVAL LEAST(3600,POW(2,attempts)) SECOND)),processing_started_at=NULL,processing_token=NULL,last_error='Processing lease expired; reclaimed' WHERE status='processing' AND processing_started_at IS NOT NULL AND processing_started_at<DATE_SUB(NOW(),INTERVAL ? MICROSECOND)",[maxAttempts,maxAttempts,leaseMs*1000]);
   await conn.execute("UPDATE telegram_notification_outbox SET post_delivery_started_at=NULL,post_delivery_token=NULL WHERE status='sent' AND delivery_recorded_at IS NULL AND post_delivery_started_at IS NOT NULL AND post_delivery_started_at<DATE_SUB(NOW(),INTERVAL ? MICROSECOND)",[leaseMs*1000]);
   const [recoveryRows]=await conn.query("SELECT id,payload,notification_type,correlation_id FROM telegram_notification_outbox WHERE status='sent' AND notification_type='payment_instructions' AND delivery_recorded_at IS NULL AND (post_delivery_started_at IS NULL OR post_delivery_started_at<=DATE_SUB(NOW(),INTERVAL ? MICROSECOND)) ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED",[leaseMs*1000]);
   if(recoveryRows.length){const item=recoveryRows[0];item.mode='post_delivery';item.token=crypto.randomUUID();await conn.execute("UPDATE telegram_notification_outbox SET post_delivery_started_at=NOW(),post_delivery_token=? WHERE id=? AND status='sent' AND delivery_recorded_at IS NULL",[item.token,item.id]);await conn.commit();return item;}
   const [rows]=await conn.query("SELECT id,payload,notification_type,correlation_id FROM telegram_notification_outbox WHERE status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=NOW()) ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED");
   if(!rows.length){await conn.commit();return null;}
   const item=rows[0];item.mode='send';item.token=crypto.randomUUID();
   const [claimed]=await conn.execute("UPDATE telegram_notification_outbox SET status='processing',attempts=attempts+1,processing_started_at=NOW(),processing_token=? WHERE id=? AND status='pending'",[item.token,item.id]);
   if(claimed.affectedRows!==1)throw new Error("Notification outbox item could not be claimed");
   await conn.commit();return item;
  }catch(error){await conn.rollback();throw error;}finally{conn.release();}
 }
 async function withHeartbeat(item,callback){
  let leaseLost=false;
  const column=item.mode==='post_delivery'?'post_delivery_started_at':'processing_started_at';
  const tokenColumn=item.mode==='post_delivery'?'post_delivery_token':'processing_token';
  const status=item.mode==='post_delivery'?'sent':'processing';
  const heartbeat=setInterval(async()=>{try{const [result]=await db.execute("UPDATE telegram_notification_outbox SET "+column+"=NOW() WHERE id=? AND status=? AND "+tokenColumn+"=?",[item.id,status,item.token]);if(result.affectedRows!==1)leaseLost=true;}catch(error){leaseLost=true;logger.error("Notification outbox lease heartbeat error:",error.message);}},heartbeatMs);
  heartbeat.unref?.();
  try{await callback(()=>leaseLost);if(leaseLost)throw new Error("Notification outbox processing lease was lost");}finally{clearInterval(heartbeat);}
 }
 async function finishPostDelivery(item,data){
  if(typeof onSent==='function')await onSent({id:item.id,notificationType:item.notification_type,payload:data,correlationId:item.correlation_id||null});
  const [result]=await db.execute("UPDATE telegram_notification_outbox SET delivery_recorded_at=NOW(),post_delivery_started_at=NULL,post_delivery_token=NULL,last_error=NULL WHERE id=? AND status='sent' AND post_delivery_token=? AND delivery_recorded_at IS NULL",[item.id,item.token]);
  if(result.affectedRows!==1)throw new Error("Card delivery audit claim was lost before finalization");
 }
 async function releasePostDelivery(item,error){
  await db.execute("UPDATE telegram_notification_outbox SET post_delivery_started_at=NULL,post_delivery_token=NULL,last_error=? WHERE id=? AND status='sent' AND post_delivery_token=? AND delivery_recorded_at IS NULL",[String(error.message||"Unknown error").slice(0,500),item.id,item.token]).catch(updateError=>logger.error("Post-delivery recovery reset error:",updateError.message));
 }
 async function processOne(){
  if(busy)return false;busy=true;let item=null;
  try{
   item=await claim();if(!item)return false;
   const data=typeof item.payload==="string"?JSON.parse(item.payload):item.payload;
   if(item.mode==='post_delivery'){
    try{await withHeartbeat(item,async()=>runWithCorrelation(item.correlation_id||crypto.randomUUID(),()=>finishPostDelivery(item,data)));return true;}
    catch(error){logger.error("Notification post-delivery recovery error ["+(item.correlation_id||item.id)+"]:",error.message);await releasePostDelivery(item,error);return false;}
   }
   let requiresAudit=false;
   await withHeartbeat(item,async isLeaseLost=>{
    await send(data.method,data.payload);
    if(isLeaseLost())throw new Error("Notification outbox processing lease was lost during Telegram delivery");
    requiresAudit=item.notification_type==='payment_instructions'&&Boolean(data.delivery_card)&&typeof onSent==='function';
    const [result]=await db.execute("UPDATE telegram_notification_outbox SET status='sent',sent_at=NOW(),processing_started_at=NULL,processing_token=NULL,last_error=NULL,post_delivery_started_at=IF(?,NOW(),NULL),post_delivery_token=IF(?,?,NULL) WHERE id=? AND status='processing' AND processing_token=?",[requiresAudit?1:0,item.token,requiresAudit?item.token:null,item.id,item.token]);
    if(result.affectedRows!==1)throw new Error("Outbox claim was lost after Telegram send; delivery may be duplicated on retry");
   });
   if(requiresAudit){
    try{await withHeartbeat({...item,mode:'post_delivery'},async()=>runWithCorrelation(item.correlation_id||crypto.randomUUID(),()=>finishPostDelivery(item,data)));}
    catch(error){logger.error("Notification card-history write failed after successful Telegram delivery ["+(item.correlation_id||item.id)+"]:",error.message);await releasePostDelivery({...item,mode:'post_delivery'},error);return false;}
   }
   return true;
  }catch(error){
   logger.error("Notification outbox error ["+(item?.correlation_id||item?.id||"unclaimed")+"]:",error.message);
   if(item?.token&&item.mode==='send')await db.execute("UPDATE telegram_notification_outbox SET status=IF(attempts>=?,'failed','pending'),next_attempt_at=IF(attempts>=?,NULL,DATE_ADD(NOW(),INTERVAL LEAST(3600,POW(2,attempts)) SECOND)),processing_started_at=NULL,processing_token=NULL,last_error=? WHERE id=? AND status='processing' AND processing_token=?",[maxAttempts,maxAttempts,String(error.message||"Unknown error").slice(0,500),item.id,item.token]).catch(updateError=>logger.error("Outbox retry update error:",updateError.message));
   return false;
  }finally{busy=false;}
 }
 function start(){if(timer)return;timer=setInterval(()=>processOne().catch(error=>logger.error("Outbox worker error:",error.message)),pollInterval);timer.unref?.();}
 async function stop(timeoutMs=30000){if(timer)clearInterval(timer);timer=null;const deadline=Date.now()+Math.max(0,timeoutMs);while(busy&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));return !busy;}
 return {processOne,start,stop};
}
module.exports={createNotificationOutbox};
