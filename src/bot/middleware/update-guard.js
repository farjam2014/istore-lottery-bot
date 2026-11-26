import {randomUUID} from 'node:crypto';
import {pool} from '../../database/pool.js';
import {logger} from '../../shared/logger.js';
import {withCorrelation} from '../../shared/request-context.js';

const counters=new Map();
const LEASE_MINUTES=5;
const HEARTBEAT_INTERVAL_MS=30_000;
const MAX_ATTEMPTS=8;

function ratePolicy(ctx){
  if(ctx.callbackQuery)return {bucket:'callback',max:35};
  if(ctx.message?.text)return {bucket:'text',max:10};
  return {bucket:'other',max:20};
}

export function createUpdateGuard({
  database=pool,
  log=logger,
  correlate=withCorrelation,
  uuid=randomUUID,
  heartbeatIntervalMs=HEARTBEAT_INTERVAL_MS,
  leaseMinutes=LEASE_MINUTES
}={}){
  return async(ctx,next)=>{
    const updateId=ctx.update?.update_id;
    if(!Number.isSafeInteger(updateId))return next();

    const userId=ctx.from?.id;
    const correlationId=`tg-${updateId}-${uuid().slice(0,8)}`;
    ctx.state??={};
    ctx.state.correlationId=correlationId;

    return correlate(correlationId,async()=>{
      const leaseToken=uuid();
      let claimed=false;
      let heartbeatTimer=null;
      let heartbeatRunning=false;
      try{
        const [insertResult]=await database.execute(
          "INSERT IGNORE INTO telegram_update_inbox(update_id,payload,status,available_at) VALUES(?,?,'pending',UTC_TIMESTAMP())",
          [updateId,JSON.stringify(ctx.update)]
        );
        const alreadyPersisted=Number(insertResult?.affectedRows)===0;
        const [claim]=await database.execute(
          "UPDATE telegram_update_inbox SET status='processing',locked_at=UTC_TIMESTAMP(),lease_token=?,attempts=attempts+1,last_error=NULL WHERE update_id=? AND ((status IN ('pending','failed') AND available_at<=UTC_TIMESTAMP()) OR (status='processing' AND locked_at<UTC_TIMESTAMP()-INTERVAL ? MINUTE))",
          [leaseToken,updateId,leaseMinutes]
        );
        if(!claim.affectedRows){
          const [[row]]=await database.execute('SELECT status FROM telegram_update_inbox WHERE update_id=?',[updateId]);
          if(row?.status==='completed'&&ctx.callbackQuery)await ctx.answerCbQuery().catch(()=>{});
          return;
        }
        claimed=true;
        heartbeatTimer=setInterval(async()=>{
          if(heartbeatRunning)return;
          heartbeatRunning=true;
          try{
            const [renewed]=await database.execute(
              "UPDATE telegram_update_inbox SET locked_at=UTC_TIMESTAMP() WHERE update_id=? AND lease_token=? AND status='processing'",
              [updateId,leaseToken]
            );
            if(renewed?.affectedRows===0)log.warn({updateId},'Telegram update lease was lost during processing');
          }catch(error){log.warn({err:error,updateId},'Telegram update lease heartbeat failed');}
          finally{heartbeatRunning=false;}
        },heartbeatIntervalMs);
        heartbeatTimer.unref?.();

        const [[attempt]]=await database.execute('SELECT attempts FROM telegram_update_inbox WHERE update_id=?',[updateId]);
        const replay=alreadyPersisted||Number(attempt?.attempts)>1;
        ctx.state.durableReplay=replay;

        if(ctx.callbackQuery){
          const answerCallback=ctx.answerCbQuery.bind(ctx);
          ctx.answerCbQuery=(...args)=>Promise.resolve(answerCallback(...args)).catch(error=>{
            const message=String(error?.message||error);
            if(error?.response?.error_code===400&&/query is too old|response timeout expired|query id is invalid/i.test(message)){
              log.warn({updateId},'Telegram callback acknowledgement expired; continuing handler');
              return;
            }
            throw error;
          });
        }

        // Callback query IDs expire quickly. Replaying them cannot reliably
        // acknowledge the spinner and may repeat stale callback failures.
        // The first attempt already reports the failure; let the user retry
        // with a fresh button press instead of replaying an expired callback.
        if(replay&&ctx.callbackQuery){
          await database.execute("UPDATE telegram_update_inbox SET status='completed',completed_at=UTC_TIMESTAMP(),locked_at=NULL,lease_token=NULL WHERE update_id=? AND lease_token=? AND status='processing'",[updateId,leaseToken]);
          claimed=false;
          return;
        }

        if(userId&&!replay){
          const policy=ratePolicy(ctx);
          await database.execute(
            "INSERT INTO telegram_rate_limits(telegram_user_id,bucket,window_started_at,request_count) VALUES(?,?,UTC_TIMESTAMP(),1) ON DUPLICATE KEY UPDATE request_count=IF(window_started_at<=UTC_TIMESTAMP()-INTERVAL 10 SECOND,1,request_count+1),window_started_at=IF(window_started_at<=UTC_TIMESTAMP()-INTERVAL 10 SECOND,UTC_TIMESTAMP(),window_started_at)",
            [String(userId),policy.bucket]
          );
          const [[counter]]=await database.execute(
            'SELECT request_count FROM telegram_rate_limits WHERE telegram_user_id=? AND bucket=?',
            [String(userId),policy.bucket]
          );
          if(Number(counter?.request_count)>policy.max){
            if(ctx.callbackQuery)await ctx.answerCbQuery('درخواست‌های شما بیش از حد مجاز است. کمی بعد دوباره تلاش کنید.',{show_alert:true}).catch(()=>{});
            else if(ctx.chat?.id)await ctx.reply('تعداد درخواست‌ها زیاد است. لطفاً چند ثانیه صبر کنید.').catch(()=>{});
            await database.execute("UPDATE telegram_update_inbox SET status='completed',completed_at=UTC_TIMESTAMP(),locked_at=NULL,lease_token=NULL WHERE update_id=? AND lease_token=?",[updateId,leaseToken]);
            claimed=false;
            return;
          }
        }

        const count=(counters.get('cleanup')||0)+1;
        counters.set('cleanup',count);
        if(count%500===0){
          try{
            await Promise.all([
              database.execute("DELETE FROM telegram_update_inbox WHERE status='completed' AND completed_at<UTC_TIMESTAMP()-INTERVAL 3 DAY"),
              database.execute('DELETE FROM processed_updates WHERE processed_at<UTC_TIMESTAMP()-INTERVAL 3 DAY'),
              database.execute('DELETE FROM telegram_rate_limits WHERE window_started_at<UTC_TIMESTAMP()-INTERVAL 1 DAY')
            ]);
          }catch(error){log.warn({err:error,updateId},'Telegram update cleanup failed; request processing continues');}
        }

        await next();
        await database.execute("UPDATE telegram_update_inbox SET status='completed',completed_at=UTC_TIMESTAMP(),locked_at=NULL,lease_token=NULL,last_error=NULL WHERE update_id=? AND lease_token=? AND status='processing'",[updateId,leaseToken]);
        claimed=false;
      }catch(error){
        log.error({err:error,updateId,userId},'Telegram update processing failed');
        if(claimed){
          const [[currentAttempt]]=await database.execute('SELECT attempts FROM telegram_update_inbox WHERE update_id=? AND lease_token=?',[updateId,leaseToken]).catch(()=>[[]]);
          const attempts=Number(currentAttempt?.attempts||0);
          const terminal=attempts>=MAX_ATTEMPTS;
          const delay=terminal?30*24*60*60:Math.min(3600,Math.pow(2,Math.max(1,attempts))*15);
          await database.execute(
            "UPDATE telegram_update_inbox SET status='failed',available_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? SECOND),locked_at=NULL,lease_token=NULL,last_error=? WHERE update_id=? AND lease_token=? AND status='processing'",
            [delay,'handler_failed',updateId,leaseToken]
          ).catch(cleanupError=>log.error({err:cleanupError,updateId},'Failed to release Telegram update lease'));
        }
        throw error;
      }finally{
        if(heartbeatTimer)clearInterval(heartbeatTimer);
      }
    });
  };
}

export function updateGuard(){
  return createUpdateGuard();
}
