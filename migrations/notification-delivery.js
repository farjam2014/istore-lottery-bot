'use strict';
async function up(db) {
 const [tables]=await db.execute("SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='payment_order_card_deliveries' LIMIT 1");
 if(!tables.length)throw new Error('notification-delivery migration requires payment_order_card_deliveries; run bank-cards first.');
 const [columns]=await db.execute("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='payment_order_card_deliveries' AND COLUMN_NAME='outbox_id'");
 if(!columns.length)await db.query("ALTER TABLE payment_order_card_deliveries ADD COLUMN outbox_id BIGINT UNSIGNED NULL AFTER order_id");
 // The unique index is added by operational-observability after it repairs any
 // duplicate links left by a partially applied/legacy delivery migration.
 return {ok:true,feature:'outbox-card-delivery-audit',outboxColumn:true};
}
module.exports={up};
