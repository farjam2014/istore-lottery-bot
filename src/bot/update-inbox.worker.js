import {pool} from '../database/pool.js';
import {logger} from '../shared/logger.js';

const LEASE_MINUTES=2;

export function createUpdateInboxWorker({database=pool,log=logger}={}){
  return async(bot,{limit=10}={})=>{
    const [rows]=await database.execute(
      "SELECT update_id,payload FROM telegram_update_inbox WHERE (status IN ('pending','failed') AND available_at<=UTC_TIMESTAMP()) OR (status='processing' AND locked_at<UTC_TIMESTAMP()-INTERVAL ? MINUTE) ORDER BY update_id LIMIT ?",
      [LEASE_MINUTES,Math.max(1,Math.min(50,Number(limit)||10))]
    );
    let replayed=0,failed=0;
    for(const row of rows){
      try{
        const update=typeof row.payload==='string'?JSON.parse(row.payload):row.payload;
        if(!update||!Number.isSafeInteger(update.update_id)||Number(update.update_id)!==Number(row.update_id))throw new Error('Inbox payload/update ID mismatch');
        await bot.handleUpdate(update);
        replayed++;
      }catch(error){
        log.error({err:error,updateId:row.update_id},'Durable Telegram update replay failed');
        failed++;
      }
    }
    return {claimed:rows.length,replayed,failed};
  };
}

export async function processUpdateInbox(bot,options={}){
  return createUpdateInboxWorker()(bot,options);
}
