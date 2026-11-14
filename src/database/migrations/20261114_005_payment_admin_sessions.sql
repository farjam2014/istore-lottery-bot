CREATE TABLE IF NOT EXISTS payment_admin_sessions (
  telegram_user_id BIGINT NOT NULL PRIMARY KEY,
  step ENUM('search_order') NOT NULL,
  status_filter ENUM('all','awaiting_receipt','under_review','approved','rejected','cancelled','expired') NOT NULL DEFAULT 'all',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
