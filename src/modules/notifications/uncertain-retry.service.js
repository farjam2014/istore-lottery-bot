import {pool} from '../../database/pool.js';
import {getCorrelationId} from '../../shared/request-context.js';

const RETRY_BATCH_LIMIT=100;

export async function retryUncertainNotifications({adminId,expectedCount,expectedMaxId}){
  const actor=String(adminId??'');
  const expected=Number(expectedCount);
  const maxId=String(expectedMaxId??'');
  if(!/^[0-9]+$/.test(actor)||!Number.isSafeInteger(expected)||expected<1||!/^[0-9]+$/.test(maxId)){
    throw new Error('Invalid uncertain notification retry confirmation.');
  }
  const c=await pool.getConnection();
  try{
    await c.beginTransaction();
    const [[current]]=await c.execute(
      "SELECT COUNT(*) total,COALESCE(MAX(id),0) max_id FROM telegram_notification_outbox WHERE status='uncertain'"
    );
    const currentCount=Number(current.total||0);
    if(currentCount!==expected||String(current.max_id)!==maxId){
      await c.commit();
      return {confirmed:false,currentCount};
    }
    const [rows]=await c.execute(
      "SELECT id FROM telegram_notification_outbox WHERE status='uncertain' ORDER BY id LIMIT ? FOR UPDATE",
      [RETRY_BATCH_LIMIT]
    );
    if(!rows.length){
      await c.commit();
      return {confirmed:false,currentCount:0};
    }
    const ids=rows.map(row=>String(row.id));
    const placeholders=ids.map(()=>'?').join(',');
    const [updated]=await c.execute(
      "UPDATE telegram_notification_outbox SET status='pending',attempts=0,manual_retry_count=manual_retry_count+1,available_at=UTC_TIMESTAMP(),locked_at=NULL,lease_token=NULL,last_error=CONCAT(COALESCE(last_error,''),' | manually retried by ',?) WHERE status='uncertain' AND id IN ("+placeholders+")",
      [actor,...ids]
    );
    if(Number(updated.affectedRows)!==ids.length)throw new Error('Uncertain notification rows changed during confirmation; transaction aborted.');
    await c.execute(
      'INSERT INTO admin_audit_log(admin_telegram_id,correlation_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)',
      [actor,getCorrelationId(),'system.outbox_retry_uncertain','notification_outbox',null,JSON.stringify({
        count:ids.length,observedUncertainCount:currentCount,batchLimit:RETRY_BATCH_LIMIT,
        warning:'Telegram may already have delivered these messages; retry can create duplicates.'
      })]
    );
    await c.commit();
    return {confirmed:true,count:ids.length,remaining:Math.max(0,currentCount-ids.length)};
  }catch(error){await c.rollback();throw error;}finally{c.release();}
}
