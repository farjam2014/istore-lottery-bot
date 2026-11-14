'use strict';

async function columnExists(db,table,column) {
 const [rows]=await db.execute('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1',[table,column]);return rows.length>0;
}
async function indexExists(db,table,index) {
 const [rows]=await db.execute('SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=? LIMIT 1',[table,index]);return rows.length>0;
}
async function dedupeMessageIds(db,table,ownerColumn) {
 const [groups]=await db.execute('SELECT `'+ownerColumn+'` AS owner_id,telegram_message_id,MIN(id) AS keep_id FROM `'+table+'` WHERE telegram_message_id IS NOT NULL GROUP BY `'+ownerColumn+'`,telegram_message_id HAVING COUNT(*)>1');
 for(const group of groups)await db.execute('UPDATE `'+table+'` SET telegram_message_id=NULL WHERE `'+ownerColumn+'`=? AND telegram_message_id=? AND id<>?',[group.owner_id,group.telegram_message_id,group.keep_id]);
 return groups.length;
}
async function up(db) {
 await db.query("CREATE TABLE IF NOT EXISTS customer_support_tickets (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,telegram_user_id BIGINT NOT NULL,chat_id BIGINT NOT NULL,business_connection_id VARCHAR(128) NULL,message TEXT NOT NULL,telegram_message_id BIGINT NULL,status ENUM('open','answered','closed') NOT NULL DEFAULT 'open',admin_reply TEXT NULL,replied_by VARCHAR(64) NULL,replied_at DATETIME NULL,created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,KEY idx_support_status_created(status,created_at),KEY idx_support_user(telegram_user_id,created_at),UNIQUE KEY uq_support_telegram_message(telegram_user_id,telegram_message_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
 if(!(await columnExists(db,'customer_support_tickets','telegram_message_id')))await db.query('ALTER TABLE customer_support_tickets ADD COLUMN telegram_message_id BIGINT NULL');
 if(!(await columnExists(db,'profile_change_requests','telegram_message_id')))await db.query('ALTER TABLE profile_change_requests ADD COLUMN telegram_message_id BIGINT NULL');

 const supportDuplicates=await dedupeMessageIds(db,'customer_support_tickets','telegram_user_id');
 const profileDuplicates=await dedupeMessageIds(db,'profile_change_requests','participant_id');

 if(!(await indexExists(db,'customer_support_tickets','uq_support_telegram_message')))await db.query('ALTER TABLE customer_support_tickets ADD UNIQUE KEY uq_support_telegram_message(telegram_user_id,telegram_message_id)');
 if(!(await indexExists(db,'profile_change_requests','uq_profile_change_telegram_message')))await db.query('ALTER TABLE profile_change_requests ADD UNIQUE KEY uq_profile_change_telegram_message(participant_id,telegram_message_id)');
 return {ok:true,feature:'customer-flow',idempotentSupportMessages:true,idempotentProfileChanges:true,deduplicatedSupportMessages:supportDuplicates,deduplicatedProfileChanges:profileDuplicates};
}
module.exports={up};
