CREATE TABLE IF NOT EXISTS admin_action_idempotency (
  idempotency_key CHAR(64) NOT NULL PRIMARY KEY,
  action_type VARCHAR(80) NOT NULL,
  actor_telegram_id BIGINT NOT NULL,
  entity_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_admin_action_idempotency_created(created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
