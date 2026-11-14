'use strict';
async function hasIndex(db,indexName) {
 const [rows]=await db.execute("SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_support_messages' AND INDEX_NAME=? LIMIT 1",[indexName]);return rows.length>0;
}
async function hasTicketForeignKey(db) {
 const [rows]=await db.execute("SELECT 1 FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_support_messages' AND COLUMN_NAME='ticket_id' AND REFERENCED_TABLE_NAME='customer_support_tickets' LIMIT 1");return rows.length>0;
}
async function up(db) {
 const [parents]=await db.execute("SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_support_tickets' LIMIT 1");
 if(!parents.length)throw new Error('support-threads migration requires customer_support_tickets; run customer-flow first.');
 await db.query("CREATE TABLE IF NOT EXISTS customer_support_messages (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,ticket_id BIGINT UNSIGNED NOT NULL,sender_type ENUM('customer','admin','system') NOT NULL,sender_id VARCHAR(64) NOT NULL,message TEXT NOT NULL,telegram_message_id BIGINT NULL,created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,KEY idx_support_messages_ticket(ticket_id,created_at,id),UNIQUE KEY uq_support_message_telegram(ticket_id,sender_type,telegram_message_id),CONSTRAINT fk_support_message_ticket FOREIGN KEY(ticket_id) REFERENCES customer_support_tickets(id) ON DELETE RESTRICT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
 if(!(await hasIndex(db,'idx_support_messages_ticket')))await db.query('ALTER TABLE customer_support_messages ADD KEY idx_support_messages_ticket(ticket_id,created_at,id)');
 const [duplicates]=await db.execute("SELECT ticket_id,sender_type,telegram_message_id,MIN(id) AS keep_id FROM customer_support_messages WHERE telegram_message_id IS NOT NULL GROUP BY ticket_id,sender_type,telegram_message_id HAVING COUNT(*)>1");
 for(const duplicate of duplicates)await db.execute('UPDATE customer_support_messages SET telegram_message_id=NULL WHERE ticket_id=? AND sender_type=? AND telegram_message_id=? AND id<>?',[duplicate.ticket_id,duplicate.sender_type,duplicate.telegram_message_id,duplicate.keep_id]);
 if(!(await hasIndex(db,'uq_support_message_telegram')))await db.query('ALTER TABLE customer_support_messages ADD UNIQUE KEY uq_support_message_telegram(ticket_id,sender_type,telegram_message_id)');
 if(!(await hasTicketForeignKey(db)))await db.query('ALTER TABLE customer_support_messages ADD CONSTRAINT fk_support_message_ticket FOREIGN KEY(ticket_id) REFERENCES customer_support_tickets(id) ON DELETE RESTRICT');
 await db.query("INSERT IGNORE INTO customer_support_messages(ticket_id,sender_type,sender_id,message,telegram_message_id,created_at) SELECT id,'customer',CAST(telegram_user_id AS CHAR),message,telegram_message_id,created_at FROM customer_support_tickets");
 const [rows]=await db.execute("SELECT COUNT(*) AS total FROM customer_support_messages WHERE sender_type='customer'");
 return {ok:true,feature:'support-threads',backfilled:true,indexed:true,customerMessages:Number(rows[0]?.total||0),deduplicatedMessages:duplicates.length};
}
module.exports={up};
