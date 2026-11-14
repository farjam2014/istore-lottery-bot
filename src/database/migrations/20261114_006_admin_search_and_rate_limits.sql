CREATE TABLE IF NOT EXISTS admin_search_sessions (
  telegram_user_id BIGINT NOT NULL PRIMARY KEY,
  step ENUM('participant') NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS telegram_rate_limits (
  telegram_user_id BIGINT NOT NULL,
  bucket VARCHAR(40) NOT NULL,
  window_started_at DATETIME NOT NULL,
  request_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY(telegram_user_id,bucket),
  KEY idx_rate_limit_window(window_started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
