CREATE TABLE IF NOT EXISTS support_tickets (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ticket_number VARCHAR(24) NOT NULL UNIQUE,
  participant_id BIGINT UNSIGNED NOT NULL,
  category ENUM('financial','campaign','technical','security','other') NOT NULL,
  subject VARCHAR(180) NOT NULL,
  status ENUM('new','in_progress','answered','closed') NOT NULL DEFAULT 'new',
  priority ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
  assigned_admin_id BIGINT NULL,
  last_message_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_support_queue(status,priority,last_message_at),
  KEY idx_support_participant(participant_id,created_at),
  CONSTRAINT fk_support_participant FOREIGN KEY(participant_id) REFERENCES participants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS support_messages (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ticket_id BIGINT UNSIGNED NOT NULL,
  sender_type ENUM('participant','admin','system') NOT NULL,
  sender_telegram_id BIGINT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_support_messages(ticket_id,created_at),
  CONSTRAINT fk_support_message_ticket FOREIGN KEY(ticket_id) REFERENCES support_tickets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS support_sessions (
  telegram_user_id BIGINT NOT NULL PRIMARY KEY,
  step ENUM('new_message','user_reply','admin_reply') NOT NULL,
  ticket_id BIGINT UNSIGNED NULL,
  category ENUM('financial','campaign','technical','security','other') NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_support_session_ticket(ticket_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
