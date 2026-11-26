import {createBot} from './bot/register.js';
import {pingDatabase,pool,adminLockPool} from './database/pool.js';
import {logger} from './shared/logger.js';
import {expirePendingOrders} from './modules/payments/payment.service.js';
import {processNotificationOutbox} from './modules/notifications/outbox.worker.js';
import {processUpdateInbox} from './bot/update-inbox.worker.js';
import {cleanupExpiredRetentionRows} from './modules/privacy/retention-cleanup.worker.js';
import {processCampaignSchedule} from './modules/campaigns/campaign-scheduler.js';
import {loadDrawKeyring} from './modules/draw/draw-keyring.js';
import {config} from './config/env.js';
import {assertRuntimeCredentialsSeparated} from './database/migration-credentials.js';
async function main(){
 assertRuntimeCredentialsSeparated(config);
 const drawKeyringConfigured=Boolean(config.DRAW_SEED_ENCRYPTION_KEYS||config.DRAW_SEED_ENCRYPTION_KEY);
 if(config.NODE_ENV==='production'||drawKeyringConfigured)loadDrawKeyring(config);
 await pingDatabase();
 logger.info('Database connection established');
 const bot=createBot();
 const webhookInfo=await bot.telegram.getWebhookInfo();
 if(webhookInfo?.url){
  logger.warn({webhookConfigured:true},'A stale webhook was found; removing it before long polling. Pending updates are preserved.');
  await bot.telegram.deleteWebhook({drop_pending_updates:false});
 }
 let expiryRunning=false,outboxRunning=false,campaignScheduleRunning=false,updateInboxRunning=false,retentionCleanupRunning=false;
 const expiryTimer=setInterval(async()=>{
  if(expiryRunning)return;expiryRunning=true;
  try{const count=await expirePendingOrders();if(count)logger.info({count},'Expired payment orders and released reservations');}
  catch(error){logger.error({err:error},'Payment expiry worker failed');}
  finally{expiryRunning=false;}
 },60_000);
 const campaignScheduleTimer=setInterval(async()=>{
  if(campaignScheduleRunning)return;campaignScheduleRunning=true;
  try{const count=await processCampaignSchedule();if(count)logger.info({count},'Campaign schedule transitions processed');}
  catch(error){logger.error({err:error},'Campaign scheduler failed');}
  finally{campaignScheduleRunning=false;}
 },60_000);
 const updateInboxTimer=setInterval(async()=>{
  if(updateInboxRunning)return;updateInboxRunning=true;
  try{const result=await processUpdateInbox(bot,{limit:10});if(result.scanned)logger.info(result,'Durable Telegram update inbox recovery scanned');}
  catch{logger.error({reason:'update_inbox_worker_failed'},'Durable Telegram update inbox recovery failed');}
  finally{updateInboxRunning=false;}
 },15_000);
 const outboxTimer=setInterval(async()=>{
  if(outboxRunning)return;outboxRunning=true;
  try{const result=await processNotificationOutbox(bot.telegram);if(result.claimed)logger.info(result,'Notification outbox processed');}
  catch(error){logger.error({err:error},'Notification outbox worker failed');}
  finally{outboxRunning=false;}
 },15_000);
 const runRetentionCleanup=async()=>{
  if(retentionCleanupRunning)return;retentionCleanupRunning=true;
  try{const result=await cleanupExpiredRetentionRows();if(result.deleted)logger.info(result,'Expired personal-data sessions and operational metadata purged');}
  catch(error){logger.error({err:error},'Retention cleanup worker failed');}
  finally{retentionCleanupRunning=false;}
 };
 const retentionCleanupTimer=setInterval(runRetentionCleanup,15*60_000);
 expiryTimer.unref?.();outboxTimer.unref?.();campaignScheduleTimer.unref?.();updateInboxTimer.unref?.();retentionCleanupTimer.unref?.();
 void runRetentionCleanup();
 const shutdown=async signal=>{
  logger.info({signal},'Shutting down');
  clearInterval(expiryTimer);clearInterval(outboxTimer);clearInterval(campaignScheduleTimer);clearInterval(updateInboxTimer);clearInterval(retentionCleanupTimer);
  try{bot.stop(signal);}catch{}
  await Promise.all([pool.end(),adminLockPool.end()]);
  process.exit(0);
 };
 process.once('SIGINT',()=>shutdown('SIGINT'));
 process.once('SIGTERM',()=>shutdown('SIGTERM'));
 await bot.launch({dropPendingUpdates:false});
 logger.info('Telegram bot launched with long polling');
}
main().catch(error=>{logger.fatal({err:error},'Startup failed');process.exit(1);});
