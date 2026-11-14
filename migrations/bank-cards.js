'use strict';

async function columnExists(db, table, column) {
  const [rows] = await db.execute(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1',
    [table, column]
  );
  return rows.length > 0;
}

async function up(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS bank_cards (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    label VARCHAR(100) NOT NULL,
    bank_name VARCHAR(80) NULL,
    card_number CHAR(16) NOT NULL,
    cardholder_name VARCHAR(150) NOT NULL,
    status ENUM('active','inactive') NOT NULL DEFAULT 'active',
    created_by VARCHAR(64) NOT NULL,
    updated_by VARCHAR(64) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_bank_cards_status(status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  if (!(await columnExists(db, 'campaigns', 'current_payment_card_id'))) {
    await db.query('ALTER TABLE campaigns ADD COLUMN current_payment_card_id BIGINT UNSIGNED NULL AFTER payment_mode');
    await db.query('ALTER TABLE campaigns ADD KEY idx_campaign_payment_card(current_payment_card_id)');
    await db.query('ALTER TABLE campaigns ADD CONSTRAINT fk_campaign_payment_card FOREIGN KEY(current_payment_card_id) REFERENCES bank_cards(id) ON DELETE RESTRICT');
  }
  await db.query(`CREATE TABLE IF NOT EXISTS campaign_payment_card_history (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    campaign_id BIGINT UNSIGNED NOT NULL,
    card_id BIGINT UNSIGNED NOT NULL,
    changed_by VARCHAR(64) NOT NULL,
    change_reason VARCHAR(255) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_campaign_card_history(campaign_id,created_at),
    CONSTRAINT fk_campaign_card_history_campaign FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE RESTRICT,
    CONSTRAINT fk_campaign_card_history_card FOREIGN KEY(card_id) REFERENCES bank_cards(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await db.query(`CREATE TABLE IF NOT EXISTS payment_order_card_deliveries (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    order_id BIGINT UNSIGNED NOT NULL,
    card_id BIGINT UNSIGNED NOT NULL,
    card_label_snapshot VARCHAR(100) NOT NULL,
    bank_name_snapshot VARCHAR(80) NULL,
    card_number_snapshot CHAR(16) NOT NULL,
    cardholder_name_snapshot VARCHAR(150) NOT NULL,
    delivery_channel VARCHAR(32) NOT NULL DEFAULT 'telegram_bot',
    sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_order_card_deliveries(order_id,sent_at),
    CONSTRAINT fk_order_card_delivery_order FOREIGN KEY(order_id) REFERENCES payment_orders(id) ON DELETE RESTRICT,
    CONSTRAINT fk_order_card_delivery_card FOREIGN KEY(card_id) REFERENCES bank_cards(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  return { bankCards: true, campaignCardColumn: true, cardHistory: true, deliveryHistory: true };
}

module.exports = { up };
