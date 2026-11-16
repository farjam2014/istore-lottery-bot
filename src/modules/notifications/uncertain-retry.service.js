import {createHash} from 'node:crypto';
import {pool} from '../../database/pool.js';
import {getCorrelationId} from '../../shared/request-context.js';

export const UNCERTAIN_RETRY_BATCH_LIMIT=100;
const HASH_LENGTH=16;

function hashIds(ids){
  return createHash('sha256').update(ids.map(String).join(',')).digest('hex').slice(0,HASH_LENGTH);
}

export async function previewUncertainNotifications(){
  const c=await pool.getConnection();
  try{
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await c.beginTransaction();
    const [[snapshot]]=await c.execute(
      "SELECT COUNT(*) total,COALESCE(MAX(id),0) max_id FROM telegram_notification_outbox WHERE status='uncertain'"
    );
    const [rows]=await c.execute(
      "SELECT id FROM telegram_notification_outbox WHERE status='uncertain' ORDER BY id LIMIT ?",
      [UNCERTAIN_RETRY_BATCH_LIMIT]
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
    await c.rollback();
    throw error;
  }finally{
    c.release();
  }
}

export async function retryUncertainNotifications({adminId,expectedCount,expectedMaxId,expectedBatchHash}){
  const actor=String(adminId??'');
  const expected=Number(expectedCount);
  const maxId=String(expectedMaxId??'');
  const expectedHash=String(expectedBatchHash??'');
  if(!/^[0-9]+$/.test(actor)||!Number.isSafeInteger(expected)||expected<1||! /^[0-9]+$/.test(maxId)||!new RegExp('^[a-f0-9]{'+HASH_LENGTH+'}$').test(expectedHash)){
    throw new Error('Invalid uncertain notification retry confirmation.');
  }

  const c=await pool.getConnection();
  let lockAcquired=false;
  let transactionOpen=false;
  try{
    // Serialize confirmations before opening a consistent snapshot. This
    // prevents InnoDB repeatable-read gap-lock deadlocks when two admins
    // confirm the same preview concurrently.
    const [[lock]]=await c.execute('SELECT GET_LOCK(?,10) acquired',['ustore:uncertain-notification-retry']);
    if(Number(lock.acquired)!==1)throw new Error('Could not acquire uncertain notification retry lock.');
    lockAcquired=true;

    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await c.beginTransaction();
    transactionOpen=true;
    const [[current]]=await c.execute(
      "SELECT COUNT(*) total,COALESCE(MAX(id),0) max_id FROM telegram_notification_outbox WHERE status='uncertain'"
    );
    const currentCount=Number(current.total||0);
    if(currentCount!==expected||String(current.max_id)!==maxId){
      await c.commit();
      transactionOpen=false;
      return {confirmed:false,currentCount};
    }

    // Lock only the previewed oldest batch. Newer uncertain rows created after
    // the preview have IDs greater than maxId and cannot enter this batch.
    const [rows]=await c.execute(
      "SELECT id FROM telegram_notification_outbox WHERE status='uncertain' AND id<=? ORDER BY id LIMIT ? FOR UPDATE",
      [maxId,UNCERTAIN_RETRY_BATCH_LIMIT]
    );
    const ids=rows.map(row=>String(row.id));
    const expectedBatchCount=Math.min(expected,UNCERTAIN_RETRY_BATCH_LIMIT);
    if(ids.length!==expectedBatchCount||hashIds(ids)!==expectedHash){
      await c.commit();
      transactionOpen=false;
      return {confirmed:false,currentCount};
    }

    const placeholders=ids.map(()=>'?').join(',');
    const [updated]=await c.execute(
      "UPDATE telegram_notification_outbox SET status='pending',attempts=0,manual_retry_count=manual_retry_count+1,available_at=UTC_TIMESTAMP(),locked_at=NULL,lease_token=NULL,last_error=CONCAT(COALESCE(last_error,''),' | manually retried by ',?) WHERE status='uncertain' AND id<=? AND id IN ("+placeholders+")",
      [actor,maxId,...ids]
    );
    if(Number(updated.affectedRows)!==ids.length){
      throw new Error('Uncertain notification rows changed during confirmation; transaction aborted.');
    }

    await c.execute(
      'INSERT INTO admin_audit_log(admin_telegram_id,correlation_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)',
      [actor,getCorrelationId(),'system.outbox_retry_uncertain','notification_outbox',null,JSON.stringify({
        count:ids.length,
        observedUncertainCount:currentCount,
        batchLimit:UNCERTAIN_RETRY_BATCH_LIMIT,
        expectedMaxId:maxId,
        batchHash:expectedHash,
        warning:'Telegram may already have delivered these messages; retry can create duplicates.'
      })]
    );
    await c.commit();
    transactionOpen=false;
    return {confirmed:true,count:ids.length,remaining:Math.max(0,currentCount-ids.length)};
  }catch(error){
    if(transactionOpen)await c.rollback();
    throw error;
  }finally{
    if(lockAcquired){
      try{await c.execute('SELECT RELEASE_LOCK(?)',['ustore:uncertain-notification-retry']);}
      catch(releaseError){/* Closing the pooled connection also releases MySQL advisory locks. */}
    }
    c.release();
  }
}
