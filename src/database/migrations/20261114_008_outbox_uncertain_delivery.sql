ALTER TABLE telegram_notification_outbox
  MODIFY COLUMN status ENUM('pending','sending','sent','failed','uncertain') NOT NULL DEFAULT 'pending',
  ADD COLUMN lease_token CHAR(36) NULL,
  ADD KEY idx_outbox_lease(status,locked_at);
