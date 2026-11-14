ALTER TABLE processed_updates
  ADD COLUMN correlation_id VARCHAR(64) NULL AFTER update_id,
  ADD KEY idx_processed_correlation(correlation_id);

ALTER TABLE telegram_notification_outbox
  ADD COLUMN correlation_id VARCHAR(64) NULL AFTER chat_id,
  ADD COLUMN manual_retry_count SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER attempts,
  ADD KEY idx_outbox_correlation(correlation_id);

ALTER TABLE telegram_rate_limits
  MODIFY COLUMN request_count INT UNSIGNED NOT NULL DEFAULT 0;

ALTER TABLE payment_events
  ADD COLUMN correlation_id VARCHAR(64) NULL AFTER actor_telegram_id,
  ADD KEY idx_payment_event_correlation(correlation_id);

ALTER TABLE admin_audit_log
  ADD COLUMN correlation_id VARCHAR(64) NULL AFTER admin_telegram_id,
  ADD KEY idx_audit_correlation(correlation_id);
