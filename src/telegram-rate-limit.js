'use strict';

function retryableTransactionError(error) {
  return error?.code === 'ER_LOCK_DEADLOCK' || error?.code === 'ER_LOCK_WAIT_TIMEOUT' || error?.errno === 1213 || error?.errno === 1205;
}

async function consumeTelegramRateLimit(db,{userId,bucket='message',limit=25,windowMs=60000,blockMs=windowMs,connection=null}={}) {
  const id=String(userId||'').trim();
  if(!id)return {allowed:true,limited:false,retryAfterMs:0};
  if(!/^\d{1,24}$/.test(id))return {allowed:false,limited:true,retryAfterMs:windowMs,reason:'invalid_user'};
  const safeBucket=String(bucket).slice(0,32);
  const max=Math.max(1,Math.min(10000,Number(limit)||25));
  const window=Math.max(100,Math.min(3600000,Number(windowMs)||60000));
  const block=Math.max(100,Math.min(3600000,Number(blockMs)||window));
  const ownsConnection=!connection;
  const maxRetries=ownsConnection?3:0;

  for(let attempt=0;;attempt++) {
    const conn=connection||await db.getConnection();
    try {
      if(ownsConnection)await conn.beginTransaction();
      await conn.execute(
        'INSERT IGNORE INTO telegram_rate_limits(telegram_user_id,bucket,window_started_at,request_count) VALUES(?,?,UTC_TIMESTAMP(3),0)',
        [id,safeBucket]
      );
      const [[state]]=await conn.execute(
        'SELECT window_started_at,request_count,(blocked_until>UTC_TIMESTAMP(3)) AS is_blocked, GREATEST(0,TIMESTAMPDIFF(MICROSECOND,UTC_TIMESTAMP(3),blocked_until)) AS retry_us, (window_started_at<=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL ? MICROSECOND)) AS window_expired FROM telegram_rate_limits WHERE telegram_user_id=? AND bucket=? FOR UPDATE',
        [window*1000,id,safeBucket]
      );
      if(!state)throw new Error('Rate limit state could not be locked');
      if(Number(state.window_expired)===1) {
        await conn.execute(
          'UPDATE telegram_rate_limits SET window_started_at=UTC_TIMESTAMP(3),request_count=1,blocked_until=NULL WHERE telegram_user_id=? AND bucket=?',
          [id,safeBucket]
        );
        if(ownsConnection)await conn.commit();
        return {allowed:true,limited:false,retryAfterMs:0,remaining:max-1};
      }
      if(Number(state.is_blocked)===1) {
        const retryAfterMs=Math.max(100,Math.ceil(Number(state.retry_us||0)/1000));
        if(ownsConnection)await conn.commit();
        return {allowed:false,limited:true,retryAfterMs,remaining:0};
      }
      if(Number(state.request_count)>=max) {
        await conn.execute(
          'UPDATE telegram_rate_limits SET blocked_until=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? MICROSECOND) WHERE telegram_user_id=? AND bucket=?',
          [block*1000,id,safeBucket]
        );
        if(ownsConnection)await conn.commit();
        return {allowed:false,limited:true,retryAfterMs:block,remaining:0};
      }
      await conn.execute(
        'UPDATE telegram_rate_limits SET request_count=request_count+1 WHERE telegram_user_id=? AND bucket=?',
        [id,safeBucket]
      );
      if(ownsConnection)await conn.commit();
      return {allowed:true,limited:false,retryAfterMs:0,remaining:max-Number(state.request_count)-1};
    } catch(error) {
      if(ownsConnection)await conn.rollback().catch(()=>{});
      if(ownsConnection&&retryableTransactionError(error)&&attempt<maxRetries) {
        await new Promise(resolve=>setTimeout(resolve,10*(attempt+1)));
        continue;
      }
      throw error;
    } finally {
      if(ownsConnection)conn.release();
    }
  }
}

function identifyTelegramActor(update) {
  const actor=update?.callback_query?.from
    || update?.business_message?.from
    || update?.message?.from
    || update?.edited_business_message?.from
    || update?.edited_message?.from
    || update?.inline_query?.from
    || update?.chosen_inline_result?.from
    || update?.my_chat_member?.from
    || null;
  return actor?.id==null?null:String(actor.id);
}

function rateLimitBucket(update) {
  return update?.callback_query?'callback':'message';
}

module.exports={consumeTelegramRateLimit,identifyTelegramActor,rateLimitBucket,retryableTransactionError};
