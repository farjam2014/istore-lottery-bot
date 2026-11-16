import {randomUUID} from 'node:crypto';
import {pool} from '../../database/pool.js';
import {logger} from '../../shared/logger.js';
import {deliverTelegramNotification} from './telegram-delivery.js';
import {classifyTelegramDeliveryError} from './delivery-outcome.js';

const MAX_ATTEMPTS=8;
const LEASE_MINUTES=5;

export async function processNotificationOutbox(telegram,{limit=20}={}){
  const c=await pool.getConnection();let jobs=[];
  try{
    await c.beginTransaction();
    // A stale "sending" row is ambiguous: Telegram may have accepted it before
    // the process died. Never auto-send it again; require an explicit operator retry.
    const [stale]=await c.execute(
      "UPDATE telegram_notification_outbox SET status='uncertain',locked_at=NULL,lease_token=NULL,last_error=COALESCE(last_error,'Delivery outcome unknown after worker lease expired') WHERE status='sending' AND locked_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL ? MINUTE)",
      [LEASE_MINUTES]
    );
    if(stale.affectedRows)logger.warn({count:stale.affectedRows},'Expired notification leases moved to uncertain; automatic resend was prevented');
    const [rows]=await c.execute(
      "SELECT id,chat_id,payload,attempts,correlation_id FROM telegram_notification_outbox WHERE status='pending' AND available_at<=UTC_TIMESTAMP() ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED",
      [Math.max(1,Math.min(100,Number(limit)||20))]
    );
    jobs=rows.map(row=>({...row,leaseToken:randomUUID()}));
    for(const job of jobs)await c.execute(
      "UPDATE telegram_notification_outbox SET status='sending',locked_at=UTC_TIMESTAMP(),lease_token=?,attempts=attempts+1,last_error=NULL WHERE id=? AND status='pending'",
      [job.leaseToken,job.id]
    );
    await c.commit();
  }catch(error){await c.rollback();throw error;}finally{c.release();}

  let delivered=0,failed=0,uncertain=0;
  for(const job of jobs){
    let payload;
    try{
      payload=typeof job.payload==='string'?JSON.parse(job.payload):job.payload;
      if(!payload||(!((typeof payload.text==='string')&&payload.text.trim())&&!(typeof payload.photo==='string'&&payload.photo.trim()&&typeof payload.caption==='string'&&payload.caption.trim())))throw new Error('Invalid notification payload: text or photo with caption is required');
    }catch(error){
      const attempts=Number(job.attempts)+1;
      await pool.execute(
        "UPDATE telegram_notification_outbox SET status='failed',locked_at=NULL,lease_token=NULL,last_error=? WHERE id=? AND lease_token=? AND status='sending'",
        [String(error.message||error).slice(0,500),job.id,job.leaseToken]
      );
      logger.error({err:error,notificationId:job.id,correlationId:job.correlation_id},'Notification payload rejected');
      failed++;continue;
    }

    try{
      await deliverTelegramNotification(telegram,String(job.chat_id),payload);
    }catch(error){
      const attempts=Number(job.attempts)+1;
      const outcome=classifyTelegramDeliveryError(error);
      const errorText=String(error?.message||'Telegram delivery failed').slice(0,500);
      if(outcome.kind==='uncertain'){
        await pool.execute(
          "UPDATE telegram_notification_outbox SET status='uncertain',locked_at=NULL,lease_token=NULL,last_error=? WHERE id=? AND lease_token=? AND status='sending'",
          [errorText,job.id,job.leaseToken]
        );
        logger.warn({err:error,notificationId:job.id,correlationId:job.correlation_id,attempts,outcome:outcome.reason},'Telegram delivery outcome is ambiguous; automatic resend was prevented');
        uncertain++;continue;
      }
      const dead=outcome.kind==='permanent'||attempts>=MAX_ATTEMPTS;
      const delay=outcome.retryAfterSeconds??Math.min(3600,Math.pow(2,Math.min(attempts,10))*15);
      await pool.execute(
        "UPDATE telegram_notification_outbox SET status=?,available_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? SECOND),locked_at=NULL,lease_token=NULL,last_error=? WHERE id=? AND lease_token=? AND status='sending'",
        [dead?'failed':'pending',delay,errorText,job.id,job.leaseToken]
      );
      logger.warn({err:error,notificationId:job.id,correlationId:job.correlation_id,attempts,willRetry:!dead,outcome:outcome.kind},'Telegram notification delivery failed');
      failed++;continue;
    }

    // If this database write fails after Telegram accepted the message, leave the
    // lease intact. The next worker will mark it uncertain rather than duplicate it.
    const [updated]=await pool.execute(
      "UPDATE telegram_notification_outbox SET status='sent',sent_at=UTC_TIMESTAMP(),locked_at=NULL,lease_token=NULL,last_error=NULL WHERE id=? AND lease_token=? AND status='sending'",
      [job.id,job.leaseToken]
    );
    if(updated.affectedRows){delivered++;}else{uncertain++;}
  }
  return {claimed:jobs.length,delivered,failed,uncertain};
}
