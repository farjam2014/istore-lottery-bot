import {randomUUID} from 'node:crypto';
import {pool} from '../../database/pool.js';
import {logger} from '../../shared/logger.js';
import {withCorrelation} from '../../shared/request-context.js';
import {claimProcessedUpdate,completeProcessedUpdate,releaseProcessedUpdate} from '../../modules/telegram/processed-update.service.js';

const counters=new Map();

function ratePolicy(ctx){
  if(ctx.callbackQuery)return {bucket:'callback',max:35};
  if(ctx.message?.text)return {bucket:'text',max:10};
  return {bucket:'other',max:20};
}

async function safeRelease(updateId,leaseToken){
  try{return await releaseProcessedUpdate({updateId,leaseToken});}
  catch(error){logger.error({err:error,updateId},'Failed to release Telegram update lease');return false;}
}

async function safeComplete(updateId,leaseToken){
  try{
    const completed=await completeProcessedUpdate({updateId,leaseToken});
    if(!completed)logger.warn({updateId},'Telegram update lease was no longer owned at completion');
    return completed;
  }catch(error){
    logger.error({err:error,updateId},'Failed to mark Telegram update completed; lease will expire for recovery');
    return false;
  }
}

export function updateGuard(){
  return async(ctx,next)=>{
    const updateId=ctx.update?.update_id;
    if(!Number.isSafeInteger(updateId))return next();

    const userId=ctx.from?.id;
    const proposedCorrelationId=`tg-${updateId}-${randomUUID().slice(0,8)}`;
    let claim;
    try{
      claim=await claimProcessedUpdate({updateId,correlationId:proposedCorrelationId});
    }catch(error){
      logger.error({err:error,updateId,userId},'Telegram update claim failed');
      throw error;
    }
    if(!claim.claimed){
      if(ctx.callbackQuery)await ctx.answerCbQuery().catch(()=>{});
      return;
    }

    const correlationId=claim.correlationId;
    const leaseToken=claim.leaseToken;
    ctx.state.correlationId=correlationId;
    let claimFinalized=false;

    return withCorrelation(correlationId,async()=>{
      try{
        if(claim.isNew&&userId){
          const policy=ratePolicy(ctx);
          await pool.execute(
            "INSERT INTO telegram_rate_limits(telegram_user_id,bucket,window_started_at,request_count) VALUES(?,?,UTC_TIMESTAMP(),1) ON DUPLICATE KEY UPDATE request_count=IF(window_started_at<=UTC_TIMESTAMP()-INTERVAL 10 SECOND,1,request_count+1),window_started_at=IF(window_started_at<=UTC_TIMESTAMP()-INTERVAL 10 SECOND,UTC_TIMESTAMP(),window_started_at)",
            [String(userId),policy.bucket]
          );
          const [[counter]]=await pool.execute(
            'SELECT request_count FROM telegram_rate_limits WHERE telegram_user_id=? AND bucket=?',
            [String(userId),policy.bucket]
          );
          if(Number(counter?.request_count)>policy.max){
            if(ctx.callbackQuery)await ctx.answerCbQuery('درخواست‌های شما بیش از حد مجاز است. کمی بعد دوباره تلاش کنید.',{show_alert:true}).catch(()=>{});
            else if(ctx.chat?.id)await ctx.reply('تعداد درخواست‌ها زیاد است. لطفاً چند ثانیه صبر کنید.').catch(()=>{});
            await safeComplete(updateId,leaseToken);
            claimFinalized=true;
            return;
          }
        }

        const count=(counters.get('cleanup')||0)+1;
        counters.set('cleanup',count);
        if(count%500===0){
          try{
            await Promise.all([
              pool.execute("DELETE FROM processed_updates WHERE (status='completed' AND processed_at<UTC_TIMESTAMP()-INTERVAL 3 DAY) OR (status='processing' AND lease_expires_at<UTC_TIMESTAMP()-INTERVAL 1 DAY)"),
              pool.execute('DELETE FROM telegram_rate_limits WHERE window_started_at<UTC_TIMESTAMP()-INTERVAL 1 DAY')
            ]);
          }catch(error){
            logger.warn({err:error,updateId},'Telegram update cleanup failed; request processing continues');
          }
        }

        try{
          await next();
        }catch(error){
          await safeRelease(updateId,leaseToken);
          claimFinalized=true;
          throw error;
        }

        await safeComplete(updateId,leaseToken);
        claimFinalized=true;
      }catch(error){
        if(!claimFinalized){
          await safeRelease(updateId,leaseToken);
          claimFinalized=true;
        }
        logger.error({err:error,updateId,userId},'Telegram update processing failed');
        throw error;
      }
    });
  };
}
