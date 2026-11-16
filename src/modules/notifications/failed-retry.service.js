import {createHash} from 'node:crypto';
import {pool} from '../../database/pool.js';
import {getCorrelationId} from '../../shared/request-context.js';

export const FAILED_RETRY_BATCH_LIMIT=100;
const HASH_LENGTH=16;
const LOCK_NAME='ustore:failed-notification-retry';

function hashIds(ids){
  return createHash('sha256').update(ids.map(String).join(',')).digest('hex').slice(0,HASH_LENGTH);
}

export async function previewFailedNotifications(){
  const c=await pool.getConnection();
  let reusable=true;
  try{
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await c.beginTransaction();
    const [[snapshot]]=await c.execute(
      "SELECT COUNT(*) total,CAST(COALESCE(MAX(id),0) AS CHAR) max_id FROM telegram_notification_outbox WHERE status='failed'"
    );
    const [rows]=await c.execute(
      "SELECT CAST(id AS CHAR) id FROM telegram_notification_outbox WHERE status='failed' ORDER BY id LIMIT ?",
      [FAILED_RETRY_BATCH_LIMIT]
    );
    const ids=rows.map(row=>String(row.id));
    await c.commit();
    return {
      count:Number(snapshot.total||0),
      maxId:String(snapshot.max_id||0),
      batchCount:ids.length,
      batchHash:hashIds(ids)
    };
  }catch(error){
    try{await c.rollback();}catch{reusable=false;}
    throw error;
  }finally{
    if(reusable)c.release();else c.destroy();
  }
}

export async function retryFailedNotifications({adminId,expectedCount,expectedMaxId,expectedBatchHash}){
  const actor=String(adminId??'');
  const expected=Number(expectedCount);
  const maxId=String(expectedMaxId??'');
  const expectedHash=String(expectedBatchHash??'');
  if(!/^[0-9]+$/.test(actor)||!Number.isSafeInteger(expected)||expected<1||! /^[0-9]+$/.test(maxId)||!new RegExp('^[a-f0-9]{'+HASH_LENGTH+'}$').test(expectedHash)){
    throw new Error('Invalid failed notification retry confirmation.');
  }

  const c=await pool.getConnection();
  let lockAcquired=false;
  let transactionOpen=false;
  let reusable=true;
  try{
    const [[lock]]=await c.execute('SELECT GET_LOCK(?,10) acquired',[LOCK_NAME]);
    if(Number(lock.acquired)!==1)throw new Error('Could not acquire failed notification retry lock.');
    lockAcquired=true;

    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await c.beginTransaction();
    transactionOpen=true;
    const [[current]]=await c.execute(
      "SELECT COUNT(*) total,CAST(COALESCE(MAX(id),0) AS CHAR) max_id FROM telegram_notification_outbox WHERE status='failed'"
    );
    const currentCount=Number(current.total||0);
    if(currentCount!==expected||String(current.max_id)!==maxId){
      await c.commit();
      transactionOpen=false;
      return {confirmed:false,reason:'snapshot-changed',currentCount,currentMaxId:String(current.max_id)};
    }

    const [rows]=await c.execute(
      "SELECT CAST(id AS CHAR) id FROM telegram_notification_outbox WHERE status='failed' AND id<=? ORDER BY id LIMIT ? FOR UPDATE",
      [maxId,FAILED_RETRY_BATCH_LIMIT]
    );
    const ids=rows.map(row=>String(row.id));
    const expectedBatchCount=Math.min(expected,FAILED_RETRY_BATCH_LIMIT);
    if(ids.length!==expectedBatchCount||hashIds(ids)!==expectedHash){
      await c.commit();
      transactionOpen=false;
      return {confirmed:false,reason:'batch-changed',currentCount,batchCount:ids.length,expectedBatchCount,actualBatchHash:hashIds(ids)};
    }

    const placeholders=ids.map(()=>'?').join(',');
    const [updated]=await c.execute(
      "UPDATE telegram_notification_outbox SET status='pending',attempts=0,manual_retry_count=manual_retry_count+1,available_at=UTC_TIMESTAMP(),locked_at=NULL,lease_token=NULL,last_error=CONCAT(LEFT(COALESCE(last_error,''),400),' | manually retried by ',?) WHERE status='failed' AND id<=? AND id IN ("+placeholders+")",
      [actor,maxId,...ids]
    );
    if(Number(updated.affectedRows)!==ids.length){
      throw new Error('Failed notification rows changed during confirmation; transaction aborted.');
    }

    await c.execute(
      'INSERT INTO admin_audit_log(admin_telegram_id,correlation_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)',
      [actor,getCorrelationId(),'system.outbox_retry_failed','notification_outbox',null,JSON.stringify({
        count:ids.length,
        observedFailedCount:currentCount,
        batchLimit:FAILED_RETRY_BATCH_LIMIT,
        expectedMaxId:maxId,
        batchHash:expectedHash,
        warning:'These notifications exhausted automatic attempts or were rejected permanently. A transport error may occur after Telegram accepted a message; manual retry can create duplicates.'
      })]
    );
    await c.commit();
    transactionOpen=false;
    return {confirmed:true,count:ids.length,remaining:Math.max(0,currentCount-ids.length)};
  }catch(error){
    if(transactionOpen){try{await c.rollback();}catch{reusable=false;}}
    throw error;
  }finally{
    if(lockAcquired){
      try{
        const [[released]]=await c.execute('SELECT RELEASE_LOCK(?) AS released',[LOCK_NAME]);
        if(Number(released?.released)!==1)reusable=false;
      }catch{reusable=false;}
    }
    if(reusable)c.release();else c.destroy();
  }
}
