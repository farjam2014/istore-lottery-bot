'use strict';

async function up(db) {
  await db.query("ALTER TABLE lottery_sessions MODIFY step ENUM('name','phone','instagram','awaiting_contact','awaiting_confirmation','profile_name','profile_awaiting_contact','profile_instagram','profile_confirmation','profile_change_full_name','profile_change_instagram','profile_change_phone_contact','support_message') NOT NULL");
  await db.query(`CREATE TABLE IF NOT EXISTS customer_support_tickets (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    telegram_user_id BIGINT NOT NULL,
    chat_id BIGINT NOT NULL,
    business_connection_id VARCHAR(128) NULL,
    message TEXT NOT NULL,
    status ENUM('open','answered','closed') NOT NULL DEFAULT 'open',
    admin_reply TEXT NULL,
    replied_by VARCHAR(64) NULL,
    replied_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_support_status_created(status,created_at),
    KEY idx_support_user(telegram_user_id,created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  return {ok:true,feature:'customer-flow'};
}

module.exports={up};
