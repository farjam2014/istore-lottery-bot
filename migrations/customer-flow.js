'use strict';

async function up(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS customer_support_tickets (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    telegram_user_id BIGINT NOT NULL,
    chat_id BIGINT NOT NULL,
    business_connection_id VARCHAR(128) NULL,
    message TEXT NOT NULL,
    telegram_message_id BIGINT NULL,
    status ENUM('open','answered','closed') NOT NULL DEFAULT 'open',
    admin_reply TEXT NULL,
    replied_by VARCHAR(64) NULL,
    replied_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_support_status_created(status,created_at),
    KEY idx_support_user(telegram_user_id,created_at),
    UNIQUE KEY uq_support_telegram_message(telegram_user_id,telegram_message_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const [columns] = await db.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_support_tickets' AND COLUMN_NAME='telegram_message_id'");
  if (!columns.length) await db.query("ALTER TABLE customer_support_tickets ADD COLUMN telegram_message_id BIGINT NULL");
  const [indexes] = await db.query("SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_support_tickets' AND INDEX_NAME='uq_support_telegram_message'");
  if (!indexes.length) await db.query("ALTER TABLE customer_support_tickets ADD UNIQUE KEY uq_support_telegram_message(telegram_user_id,telegram_message_id)");
  const [profileColumns] = await db.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='profile_change_requests' AND COLUMN_NAME='telegram_message_id'");
  if (!profileColumns.length) await db.query("ALTER TABLE profile_change_requests ADD COLUMN telegram_message_id BIGINT NULL");
  const [profileIndexes] = await db.query("SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='profile_change_requests' AND INDEX_NAME='uq_profile_change_telegram_message'");
  if (!profileIndexes.length) await db.query("ALTER TABLE profile_change_requests ADD UNIQUE KEY uq_profile_change_telegram_message(participant_id,telegram_message_id)");
  return {ok:true,feature:'customer-flow',idempotentSupportMessages:true,idempotentProfileChanges:true};
}

module.exports={up};
