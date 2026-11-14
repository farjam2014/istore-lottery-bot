ALTER TABLE payment_orders
  DROP INDEX campaign_entry_id,
  ADD KEY idx_order_entry(campaign_entry_id),
  ADD COLUMN payment_reference VARCHAR(32) NULL AFTER id,
  ADD UNIQUE KEY uq_payment_reference(payment_reference),
  MODIFY COLUMN status ENUM('awaiting_receipt','under_review','approved','rejected','cancelled','expired') NOT NULL DEFAULT 'awaiting_receipt';
UPDATE payment_orders SET payment_reference=CONCAT('ISTPAY-',LPAD(id,12,'0')) WHERE payment_reference IS NULL;
ALTER TABLE payment_orders MODIFY COLUMN payment_reference VARCHAR(32) NOT NULL;
ALTER TABLE payment_orders ADD KEY idx_payment_expiry(status,expires_at);
ALTER TABLE telegram_notification_outbox
  ADD COLUMN last_error VARCHAR(500) NULL,
  ADD COLUMN locked_at DATETIME NULL,
  ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
