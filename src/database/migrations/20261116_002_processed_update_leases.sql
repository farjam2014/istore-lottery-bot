ALTER TABLE processed_updates
  ADD COLUMN status ENUM('processing','completed') NOT NULL DEFAULT 'completed' AFTER correlation_id,
  ADD COLUMN lease_token CHAR(36) NULL AFTER status,
  ADD COLUMN lease_expires_at DATETIME NULL AFTER lease_token,
  ADD COLUMN attempts INT UNSIGNED NOT NULL DEFAULT 1 AFTER lease_expires_at,
  ADD KEY idx_processed_update_recovery(status,lease_expires_at);
