'use strict';
async function hasColumn(db,table,column) {
 const [rows]=await db.execute('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1',[table,column]);return rows.length>0;
}
async function hasIndex(db,table,index) {
 const [rows]=await db.execute('SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=? LIMIT 1',[table,index]);return rows.length>0;
}
async function addColumn(db,table,column,definition) {
 if(!(await hasColumn(db,table,column)))await db.query('ALTER TABLE `'+table+'` ADD COLUMN `'+column+'` '+definition);
}
async function addIndex(db,table,index,definition) {
 if(!(await hasIndex(db,table,index)))await db.query('ALTER TABLE `'+table+'` ADD '+definition);
}
async function up(db) {
 const required=['webhook_inbox','telegram_notification_outbox','admin_audit_log','payment_orders','payment_order_card_deliveries'];
 for(const table of required) {
  const [rows]=await db.execute('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1',[table]);
  if(!rows.length)throw new Error('Operational migration requires table '+table+'; run base migrations first.');
 }
 for(const table of required)await addColumn(db,table,'correlation_id','CHAR(36) NULL');
 await addIndex(db,'webhook_inbox','idx_webhook_correlation','KEY `idx_webhook_correlation` (correlation_id)');
 await addIndex(db,'telegram_notification_outbox','idx_outbox_correlation','KEY `idx_outbox_correlation` (correlation_id)');
 await addIndex(db,'admin_audit_log','idx_audit_correlation','KEY `idx_audit_correlation` (correlation_id)');
 await addIndex(db,'payment_orders','idx_payment_order_correlation','KEY `idx_payment_order_correlation` (correlation_id)');
 await addIndex(db,'payment_order_card_deliveries','idx_card_delivery_correlation','KEY `idx_card_delivery_correlation` (correlation_id)');
 await addColumn(db,'telegram_notification_outbox','delivery_recorded_at','TIMESTAMP NULL DEFAULT NULL');
 await addColumn(db,'telegram_notification_outbox','post_delivery_started_at','TIMESTAMP NULL DEFAULT NULL');
 await addColumn(db,'telegram_notification_outbox','post_delivery_token','CHAR(36) NULL DEFAULT NULL');
 await addIndex(db,'telegram_notification_outbox','idx_outbox_post_delivery','KEY `idx_outbox_post_delivery` (status,delivery_recorded_at,post_delivery_started_at)');
 const [duplicateGroups]=await db.execute('SELECT outbox_id,MIN(id) AS keep_id FROM payment_order_card_deliveries WHERE outbox_id IS NOT NULL GROUP BY outbox_id HAVING COUNT(*)>1');
 for(const duplicate of duplicateGroups)await db.execute('UPDATE payment_order_card_deliveries SET outbox_id=NULL WHERE outbox_id=? AND id<>?',[duplicate.outbox_id,duplicate.keep_id]);
 const [uniqueRows]=await db.execute("SELECT COLUMN_NAME,NON_UNIQUE,SEQ_IN_INDEX FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='payment_order_card_deliveries' AND INDEX_NAME='uq_card_delivery_outbox' ORDER BY SEQ_IN_INDEX");
 if(uniqueRows.length&&!(uniqueRows.length===1&&uniqueRows[0].COLUMN_NAME==='outbox_id'&&Number(uniqueRows[0].NON_UNIQUE)===0))await db.query('ALTER TABLE payment_order_card_deliveries DROP INDEX uq_card_delivery_outbox');
 if(!(await hasIndex(db,'payment_order_card_deliveries','uq_card_delivery_outbox')))await db.query('ALTER TABLE payment_order_card_deliveries ADD UNIQUE KEY uq_card_delivery_outbox(outbox_id)');
 await db.query("CREATE TABLE IF NOT EXISTS telegram_rate_limits (telegram_user_id VARCHAR(24) NOT NULL,bucket VARCHAR(32) NOT NULL,window_started_at DATETIME(3) NOT NULL,request_count INT UNSIGNED NOT NULL DEFAULT 0,blocked_until DATETIME(3) NULL,updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,PRIMARY KEY(telegram_user_id,bucket),KEY idx_telegram_rate_blocked(blocked_until)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
 await db.query("CREATE TABLE IF NOT EXISTS webhook_rate_limit_events (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,update_id BIGINT NOT NULL,telegram_user_id VARCHAR(24) NOT NULL,bucket VARCHAR(32) NOT NULL,correlation_id CHAR(36) NULL,retry_after_ms INT UNSIGNED NOT NULL,created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE KEY uq_webhook_rate_limit_update(update_id),KEY idx_webhook_rate_user(telegram_user_id,created_at),KEY idx_webhook_rate_correlation(correlation_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
 await db.execute("UPDATE telegram_notification_outbox o JOIN payment_order_card_deliveries d ON d.outbox_id=o.id SET o.delivery_recorded_at=COALESCE(o.delivery_recorded_at,d.sent_at) WHERE o.status='sent' AND o.notification_type='payment_instructions' AND o.delivery_recorded_at IS NULL");
 return {ok:true,feature:'operational-observability',correlationColumns:required,deliveryRecovery:true,telegramRateLimits:true,deduplicatedDeliveryLinks:duplicateGroups.length};
}
module.exports={up};
