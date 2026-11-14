import {pool} from '../../database/pool.js';
const MAX_ATTEMPTS=8;
export async function processNotificationOutbox(telegram,{limit=20}={}){
  const c=await pool.getConnection();let jobs=[];
  try{
    await c.beginTransaction();
    const [rows]=await c.execute("SELECT id,chat_id,payload,attempts FROM telegram_notification_outbox WHERE (status='pending' AND available_at<=UTC_TIMESTAMP()) OR (status='sending' AND locked_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 5 MINUTE)) ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED",[Math.max(1,Math.min(100,Number(limit)||20))]);
    jobs=rows;
    for(const job of jobs)await c.execute("UPDATE telegram_notification_outbox SET status='sending',locked_at=UTC_TIMESTAMP(),attempts=attempts+1 WHERE id=?",[job.id]);
    await c.commit();
  }catch(error){await c.rollback();throw error;}finally{c.release();}
  let delivered=0;
  for(const job of jobs){
    try{
      const payload=typeof job.payload==='string'?JSON.parse(job.payload):job.payload;
      await telegram.sendMessage(String(job.chat_id),String(payload.text||''),payload.options||{});
      await pool.execute("UPDATE telegram_notification_outbox SET status='sent',sent_at=UTC_TIMESTAMP(),locked_at=NULL,last_error=NULL WHERE id=?",[job.id]);
      delivered++;
    }catch(error){
      const attempts=Number(job.attempts)+1;
      const dead=attempts>=MAX_ATTEMPTS;
      const delay=Math.min(3600,Math.pow(2,Math.min(attempts,10))*15);
      await pool.execute("UPDATE telegram_notification_outbox SET status=?,available_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? SECOND),locked_at=NULL,last_error=? WHERE id=?",[dead?'failed':'pending',delay,String(error?.message||'Telegram delivery failed').slice(0,500),job.id]);
    }
  }
  return {claimed:jobs.length,delivered};
}
