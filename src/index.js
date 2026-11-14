import {createBot} from './bot/register.js';
import {pingDatabase,pool} from './database/pool.js';
import {logger} from './shared/logger.js';
import {expirePendingOrders} from './modules/payments/payment.service.js';
import {processNotificationOutbox} from './modules/notifications/outbox.worker.js';
async function main(){
 await pingDatabase();
 logger.info('Database connection established');
 const bot=createBot();
 let expiryRunning=false,outboxRunning=false;
 const expiryTimer=setInterval(async()=>{
  if(expiryRunning)return;expiryRunning=true;
  try{const count=await expirePendingOrders();if(count)logger.info({count},'Expired payment orders and released reservations');}
  catch(error){logger.error({err:error},'Payment expiry worker failed');}
  finally{expiryRunning=false;}
 },60_000);
 const outboxTimer=setInterval(async()=>{
  if(outboxRunning)return;outboxRunning=true;
  try{const result=await processNotificationOutbox(bot.telegram);if(result.claimed)logger.info(result,'Notification outbox processed');}
  catch(error){logger.error({err:error},'Notification outbox worker failed');}
  finally{outboxRunning=false;}
 },15_000);
 expiryTimer.unref?.();outboxTimer.unref?.();
 const shutdown=async signal=>{
  logger.info({signal},'Shutting down');
  clearInterval(expiryTimer);clearInterval(outboxTimer);
  try{bot.stop(signal);}catch{}
  await pool.end();
  process.exit(0);
 };
 process.once('SIGINT',()=>shutdown('SIGINT'));
 process.once('SIGTERM',()=>shutdown('SIGTERM'));
 await bot.launch({dropPendingUpdates:false});
 logger.info('Telegram bot started using long polling');
}
main().catch(error=>{logger.fatal({err:error},'Startup failed');process.exit(1);});
