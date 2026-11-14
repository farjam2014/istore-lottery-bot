'use strict';

async function up(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS customer_support_messages (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    ticket_id BIGINT UNSIGNED NOT NULL,
    sender_type ENUM('customer','admin','system') NOT NULL,
    sender_id VARCHAR(64) NOT NULL,
    message TEXT NOT NULL,
    telegram_message_id BIGINT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_support_messages_ticket(ticket_id,created_at,id),
    UNIQUE KEY uq_support_message_telegram(ticket_id,sender_type,telegram_message_id),
    CONSTRAINT fk_support_message_ticket FOREIGN KEY(ticket_id) REFERENCES customer_support_tickets(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await db.query(`INSERT IGNORE INTO customer_support_messages(ticket_id,sender_type,sender_id,message,telegram_message_id,created_at)
    SELECT id,'customer',CAST(telegram_user_id AS CHAR),message,telegram_message_id,created_at
    FROM customer_support_tickets`);
  const [indexes] = await db.execute("SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_support_messages' AND INDEX_NAME='idx_support_messages_ticket'");
  return {ok:true,feature:'support-threads',backfilled:true,indexed:indexes.length>0};
}
module.exports={up};
