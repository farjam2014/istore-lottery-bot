import {randomUUID} from 'node:crypto';
import {pool} from '../../database/pool.js';
import {logger} from '../../shared/logger.js';
import {deliverTelegramNotification} from './telegram-delivery.js';

const MAX_ATTEMPTS=8;
const LEASE_MINUTES=5;

function telegramErrorCode(error){
  const rawCode=error?.response?.error_code??error?.response?.data?.error_code??error?.error_code??(typeof error?.code==='number'?error.code:null);
  const code=Number(rawCode);
  return Number.isInteger(code)&&code>=100&&code<=599?code:null;
}

export function safeTelegramDeliveryErrorLabel(error){
  const code=telegramErrorCode(error);
  if(code===429)return 'telegram_http_429';
  if(code===408)return 'telegram_http_408_timeout';
  if(code!==null&&code>=500)return 'telegram_http_5xx';
  if(code!==null&&code>=400)return 'telegram_http_4xx';
  return 'network_or_unknown';
}

export function classifyTelegramDeliveryError(error,attempts=1){
  const code=telegramErrorCode(error);
  const retryDelay=Math.min(3600,Math.max(1,Number(error?.response?.parameters?.retry_after??error?.parameters?.retry_after)||Math.min(3600,Math.pow(2,Math.min(attempts,10))*15)));
  if(code===429)return {status:'pending',delaySeconds:retryDelay,errorLabel:'telegram_http_429'};
  // HTTP 408 is a timeout, not proof that Telegram rejected the message. The
  // request may have been accepted before the timeout response was produced.
  // Keep it uncertain and require an explicit, audited operator decision.
  if(code===408)return {status:'uncertain',delaySeconds:0,errorLabel:'telegram_http_408_timeout'};
  if(code!==null&&code>=400&&code<500)return {status:'failed',delaySeconds:0,errorLabel:'telegram_http_4xx'};
  // Network failures and server errors are ambiguous: Telegram may have accepted
  // the message before the response was lost. Never automatically resend them.
  return {status:'uncertain',delaySeconds:0,errorLabel:code!==null&&code>=500?'telegram_http_5xx':'network_or_unknown'};
}

export function createNotificationOutboxWorker({
  database=pool,
  log=logger,
  deliver=deliverTelegramNotification,
  uuid=randomUUID
}={}){
  return async function processNotificationOutbox(telegram,{limit=20}={}){
    const c=await database.getConnection();let jobs=[];
    try{
      await c.beginTransaction();
      // A stale "sending" row is ambiguous: Telegram may have accepted it before
      // the process died. Never auto-send it again; require an explicit operator retry.
      const [stale]=await c.execute(
        "UPDATE telegram_notification_outbox SET status='uncertain',locked_at=NULL,lease_token=NULL,last_error=COALESCE(last_error,'Delivery outcome unknown after worker lease expired') WHERE status='sending' AND locked_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL ? MINUTE)",
        [LEASE_MINUTES]
      );
      if(stale.affectedRows)log.warn({count:stale.affectedRows},'Expired notification leases moved to uncertain; automatic resend was prevented');
      const [rows]=await c.execute(
        "SELECT id,chat_id,payload,attempts,correlation_id FROM telegram_notification_outbox WHERE status='pending' AND available_at<=UTC_TIMESTAMP() ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED",
        [Math.max(1,Math.min(100,Number(limit)||20))]
      );
      jobs=rows.map(row=>({...row,leaseToken:uuid()}));
      for(const job of jobs)await c.execute(
        "UPDATE telegram_notification_outbox SET status='sending',locked_at=UTC_TIMESTAMP(),lease_token=?,attempts=attempts+1,last_error=NULL WHERE id=? AND status='pending'",
        [job.leaseToken,job.id]
      );
      await c.commit();
    }catch(error){await c.rollback();throw error;}finally{c.release();}

    let delivered=0,failed=0,retried=0,uncertain=0;
    for(const job of jobs){
      let payload;
      try{
        payload=typeof job.payload==='string'?JSON.parse(job.payload):job.payload;
        if(!payload||(!((typeof payload.text==='string')&&payload.text.trim())&&!(typeof payload.photo==='string'&&payload.photo.trim()&&typeof payload.caption==='string'&&payload.caption.trim())))throw new Error('Invalid notification payload: text or photo with caption is required');
        if(typeof payload.text==='string'&&payload.text.length>4096)throw new Error('Invalid notification payload: Telegram message text exceeds 4096 characters');
        if(typeof payload.caption==='string'&&payload.caption.length>1024)throw new Error('Invalid notification payload: Telegram photo caption exceeds 1024 characters');
      }catch(error){
        await database.execute(
          "UPDATE telegram_notification_outbox SET status='failed',locked_at=NULL,lease_token=NULL,last_error=? WHERE id=? AND lease_token=? AND status='sending'",
          ['invalid_payload',job.id,job.leaseToken]
        );
        log.error({reason:'invalid_payload',notificationId:job.id,correlationId:job.correlation_id},'Notification payload rejected');
        failed++;continue;
      }

      try{
        await deliver(telegram,String(job.chat_id),payload);
      }catch(error){
        const attempts=Number(job.attempts)+1;
        const outcome=classifyTelegramDeliveryError(error,attempts);
        const dead=outcome.status==='pending'&&attempts>=MAX_ATTEMPTS;
        const status=dead?'failed':outcome.status;
        const delay=status==='pending'?outcome.delaySeconds:0;
        await database.execute(
          "UPDATE telegram_notification_outbox SET status=?,available_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? SECOND),locked_at=NULL,lease_token=NULL,last_error=? WHERE id=? AND lease_token=? AND status='sending'",
          [status,delay,outcome.errorLabel,job.id,job.leaseToken]
        );
        log.warn({errorClass:outcome.errorLabel,notificationId:job.id,correlationId:job.correlation_id,attempts,outcome:status,willRetry:status==='pending'},'Telegram notification delivery failed');
        if(status==='uncertain')uncertain++;else if(status==='pending')retried++;else failed++;
        continue;
      }

      // If this database write fails after Telegram accepted the message, leave the
      // lease intact. The next worker will mark it uncertain rather than duplicate it.
      const [updated]=await database.execute(
        "UPDATE telegram_notification_outbox SET status='sent',sent_at=UTC_TIMESTAMP(),locked_at=NULL,lease_token=NULL,last_error=NULL WHERE id=? AND lease_token=? AND status='sending'",
        [job.id,job.leaseToken]
      );
      if(updated.affectedRows){delivered++;}else{uncertain++;}
    }
    return {claimed:jobs.length,delivered,failed,retried,uncertain};
  };
}

export async function processNotificationOutbox(telegram,options={}){
  return createNotificationOutboxWorker()(telegram,options);
}
