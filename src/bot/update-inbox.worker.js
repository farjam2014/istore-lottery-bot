import {pool} from '../database/pool.js';
import {logger} from '../shared/logger.js';

const MAX_ATTEMPTS=8;
const MAX_BATCH=50;

export function createUpdateInboxWorker({database=pool,log=logger}={}){
  return async(bot,{limit=10}={})=>{
    // Keep completed updates for three days. Unprocessed/failed payloads are
    // retained for at most thirty days; stale leases are also purged.
    await database.execute(
      "DELETE FROM telegram_update_inbox WHERE status='completed' AND completed_at<UTC_TIMESTAMP()-INTERVAL 3 DAY LIMIT 500"
    );
    await database.execute(
      "DELETE FROM telegram_update_inbox WHERE status IN ('pending','failed') AND created_at<UTC_TIMESTAMP()-INTERVAL 30 DAY LIMIT 500"
    );
    await database.execute(
      "DELETE FROM telegram_update_inbox WHERE status='processing' AND locked_at<UTC_TIMESTAMP()-INTERVAL 30 DAY AND created_at<UTC_TIMESTAMP()-INTERVAL 30 DAY LIMIT 500"
    );
    const [rows]=await database.execute(
      "SELECT update_id,payload,attempts FROM telegram_update_inbox WHERE (status IN ('pending','failed') AND available_at<=UTC_TIMESTAMP()) OR (status='processing' AND locked_at<UTC_TIMESTAMP()-INTERVAL 5 MINUTE) ORDER BY update_id LIMIT ?",
      [Math.max(1,Math.min(MAX_BATCH,Number(limit)||10))]
    );
    let replayed=0,failed=0,skipped=0;
    for(const row of rows){
      let update;
      try{
        update=typeof row.payload==='string'?JSON.parse(row.payload):row.payload;
        if(!update||!Number.isSafeInteger(update.update_id)||Number(update.update_id)!==Number(row.update_id))throw new Error('Inbox payload/update ID mismatch');
      }catch(error){
        const attempt=Number(row.attempts||0)+1;
        const delay=attempt>=MAX_ATTEMPTS?30*24*60*60:Math.min(3600,Math.pow(2,attempt)*15);
        const [result]=await database.execute(
          "UPDATE telegram_update_inbox SET status='failed',attempts=attempts+1,available_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? SECOND),locked_at=NULL,lease_token=NULL,last_error=? WHERE update_id=? AND (status IN ('pending','failed') OR (status='processing' AND locked_at<UTC_TIMESTAMP()-INTERVAL 5 MINUTE))",
          [delay,String(error?.message||error).slice(0,500),row.update_id]
        );
        if(result?.affectedRows){failed++;log.error({err:error,updateId:row.update_id,attempt,terminal:attempt>=MAX_ATTEMPTS},'Malformed Telegram inbox payload quarantined');}
        else skipped++;
        continue;
      }
      try{
        await bot.handleUpdate(update);
        const [[state]]=await database.execute('SELECT status FROM telegram_update_inbox WHERE update_id=?',[row.update_id]);
        if(state?.status==='completed')replayed++;
        else if(state?.status==='failed')failed++;
        else skipped++;
      }catch(error){
        log.error({err:error,updateId:row.update_id},'Durable Telegram update replay failed');
        failed++;
      }
    }
    return {scanned:rows.length,replayed,failed,skipped};
  };
}

export async function processUpdateInbox(bot,options={}){
  return createUpdateInboxWorker()(bot,options);
}
