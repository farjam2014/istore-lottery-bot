CREATE TABLE IF NOT EXISTS lottery_entries (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 telegram_user_id BIGINT NOT NULL UNIQUE,
 chat_id BIGINT NOT NULL,
 full_name VARCHAR(150) NOT NULL,
 phone VARCHAR(25) NOT NULL,
 instagram VARCHAR(40) NOT NULL,
 raffle_code VARCHAR(20) NOT NULL UNIQUE,
 status ENUM('active','inactive','deleted') NOT NULL DEFAULT 'active',
 deletion_reason VARCHAR(255) NULL,
 deleted_at TIMESTAMP NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 active_phone VARCHAR(25) GENERATED ALWAYS AS (CASE WHEN status='active' THEN phone ELSE NULL END) STORED,
 active_instagram VARCHAR(40) GENERATED ALWAYS AS (CASE WHEN status='active' THEN LOWER(instagram) ELSE NULL END) STORED,
 UNIQUE KEY uq_entries_active_phone(active_phone),
 UNIQUE KEY uq_entries_active_instagram(active_instagram),
 KEY idx_created_at(created_at),
 KEY idx_full_name(full_name),
 KEY idx_entries_status_created(status,created_at),
 KEY idx_entries_phone(phone),
 KEY idx_entries_instagram(instagram)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS lottery_sessions (
 telegram_user_id BIGINT NOT NULL PRIMARY KEY,
 chat_id BIGINT NOT NULL,
 step ENUM('name','phone','instagram','awaiting_contact','awaiting_confirmation') NOT NULL,
 full_name VARCHAR(150) DEFAULT NULL,
 phone VARCHAR(25) DEFAULT NULL,
 instagram VARCHAR(40) DEFAULT NULL,
 business_connection_id VARCHAR(128) NOT NULL,
 updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS processed_updates (
 update_id BIGINT PRIMARY KEY,
 processed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS webhook_inbox (
 update_id BIGINT NOT NULL PRIMARY KEY,
 payload JSON NOT NULL,
 status ENUM('pending','processing','done','failed') NOT NULL DEFAULT 'pending',
 attempts INT UNSIGNED NOT NULL DEFAULT 0,
 last_error VARCHAR(500) NULL,
 received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 processing_started_at TIMESTAMP NULL DEFAULT NULL,
 processing_token CHAR(36) NULL DEFAULT NULL,
 processed_at TIMESTAMP NULL,
 KEY idx_inbox_status_received(status,received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS lottery_settings (
 setting_key VARCHAR(64) PRIMARY KEY,
 setting_value TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS lottery_draws (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 winner_entry_id BIGINT UNSIGNED NOT NULL,
 winner_code VARCHAR(20) NOT NULL,
 drawn_by VARCHAR(80) NOT NULL,
 draw_seed VARCHAR(80) NOT NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS lottery_draw_participants (
 draw_id BIGINT UNSIGNED NOT NULL,
 entry_id BIGINT UNSIGNED NOT NULL,
 raffle_code VARCHAR(20) NOT NULL,
 PRIMARY KEY(draw_id,entry_id),
 UNIQUE KEY uq_draw_code(draw_id,raffle_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS admin_audit_log (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 admin_id VARCHAR(64) NOT NULL,
 action VARCHAR(64) NOT NULL,
 entity_type VARCHAR(64) NOT NULL,
 entity_id VARCHAR(64) NULL,
 details JSON NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 KEY idx_audit_created(created_at),
 KEY idx_audit_entity(entity_type,entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


CREATE TABLE IF NOT EXISTS released_codes (
 raffle_code VARCHAR(20) PRIMARY KEY,
 source_entry_id BIGINT UNSIGNED NOT NULL,
 released_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 KEY idx_released_at(released_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS lottery_code_history (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 entry_id BIGINT UNSIGNED NOT NULL,
 raffle_code VARCHAR(20) NOT NULL,
 action ENUM('assigned','released') NOT NULL,
 actor VARCHAR(80) NOT NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 KEY idx_code_history_entry(entry_id,created_at),
 KEY idx_code_history_code(raffle_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO lottery_settings(setting_key,setting_value) VALUES('registration_open','false'),('draw_completed','false');


CREATE TABLE IF NOT EXISTS telegram_notification_outbox (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 dedupe_key VARCHAR(128) NOT NULL UNIQUE,
 notification_type VARCHAR(64) NOT NULL,
 payload JSON NOT NULL,
 status ENUM('pending','processing','sent','failed') NOT NULL DEFAULT 'pending',
 attempts INT UNSIGNED NOT NULL DEFAULT 0,
 next_attempt_at TIMESTAMP NULL DEFAULT NULL,
 processing_started_at TIMESTAMP NULL DEFAULT NULL,
 processing_token CHAR(36) NULL DEFAULT NULL,
 last_error VARCHAR(500) NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 sent_at TIMESTAMP NULL,
 KEY idx_notification_status_created(status,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
