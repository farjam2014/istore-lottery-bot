CREATE TABLE IF NOT EXISTS profile_change_sessions (
  telegram_user_id BIGINT NOT NULL PRIMARY KEY,
  step ENUM('full_name','phone','instagram_handle') NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
