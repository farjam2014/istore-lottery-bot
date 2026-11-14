CREATE TABLE IF NOT EXISTS admin_users (
  telegram_user_id BIGINT NOT NULL PRIMARY KEY,
  role ENUM('super_admin','campaign_manager','finance_manager','support_agent') NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  display_name VARCHAR(120) NULL,
  added_by BIGINT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_admin_role_active(role,is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS admin_role_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  target_telegram_id BIGINT NOT NULL,
  actor_telegram_id BIGINT NOT NULL,
  action ENUM('assigned','role_changed','activated','deactivated') NOT NULL,
  role_before VARCHAR(40) NULL,
  role_after VARCHAR(40) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_admin_role_events_target(target_telegram_id,created_at),
  KEY idx_admin_role_events_actor(actor_telegram_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS admin_role_sessions (
  telegram_user_id BIGINT NOT NULL PRIMARY KEY,
  role ENUM('campaign_manager','finance_manager','support_agent') NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
