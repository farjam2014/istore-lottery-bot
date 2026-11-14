'use strict';
async function up(db) {
  const [columns]=await db.execute("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='payment_order_card_deliveries' AND COLUMN_NAME='outbox_id'");
  if(!columns.length)await db.query("ALTER TABLE payment_order_card_deliveries ADD COLUMN outbox_id BIGINT UNSIGNED NULL AFTER order_id");
  const [indexes]=await db.execute("SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='payment_order_card_deliveries' AND INDEX_NAME='uq_card_delivery_outbox'");
  if(!indexes.length)await db.query("ALTER TABLE payment_order_card_deliveries ADD UNIQUE KEY uq_card_delivery_outbox(outbox_id)");
  return {ok:true,feature:'outbox-card-delivery-audit'};
}
module.exports={up};
