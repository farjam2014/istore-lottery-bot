import {pool} from '../../database/pool.js';
import {logger} from '../../shared/logger.js';

const counters=new Map();
function ratePolicy(ctx){
  if(ctx.callbackQuery)return {bucket:'callback',max:35};
  if(ctx.message?.text)return {bucket:'text',max:10};
  return {bucket:'other',max:20};
}
export function updateGuard(){
  return async(ctx,next)=>{
    const updateId=ctx.update?.update_id;
    if(!Number.isSafeInteger(updateId))return next();
    const userId=ctx.from?.id;
    try{
      const [insert]=await pool.execute('INSERT IGNORE INTO processed_updates(update_id) VALUES(?)',[updateId]);
      if(!insert.affectedRows){
        if(ctx.callbackQuery)await ctx.answerCbQuery().catch(()=>{});
        return;
      }
      if(userId){
        const policy=ratePolicy(ctx);
        await pool.execute(
          "INSERT INTO telegram_rate_limits(telegram_user_id,bucket,window_started_at,request_count) VALUES(?,?,UTC_TIMESTAMP(),1) ON DUPLICATE KEY UPDATE request_count=IF(window_started_at<=UTC_TIMESTAMP()-INTERVAL 10 SECOND,1,request_count+1),window_started_at=IF(window_started_at<=UTC_TIMESTAMP()-INTERVAL 10 SECOND,UTC_TIMESTAMP(),window_started_at)",
          [String(userId),policy.bucket]
        );
        const [[counter]]=await pool.execute('SELECT request_count FROM telegram_rate_limits WHERE telegram_user_id=? AND bucket=?',[String(userId),policy.bucket]);
        if(Number(counter?.request_count)>policy.max){
          if(ctx.callbackQuery)await ctx.answerCbQuery('درخواست‌های شما بیش از حد مجاز است. کمی بعد دوباره تلاش کنید.',{show_alert:true}).catch(()=>{});
          else if(ctx.chat?.id)await ctx.reply('تعداد درخواست‌ها زیاد است. لطفاً چند ثانیه صبر کنید.').catch(()=>{});
          return;
        }
      }
      const count=(counters.get('cleanup')||0)+1;counters.set('cleanup',count);
      if(count%500===0){
        await pool.execute('DELETE FROM processed_updates WHERE processed_at<UTC_TIMESTAMP()-INTERVAL 3 DAY');
        await pool.execute('DELETE FROM telegram_rate_limits WHERE window_started_at<UTC_TIMESTAMP()-INTERVAL 1 DAY');
      }
      try{return await next();}
      catch(error){
        await pool.execute('DELETE FROM processed_updates WHERE update_id=?',[updateId]).catch(cleanupError=>logger.error({err:cleanupError,updateId},'Failed to release Telegram update claim'));
        throw error;
      }
    }catch(error){
      logger.error({err:error,updateId},'Telegram update guard failed');
      throw error;
    }
  };
}
