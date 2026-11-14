'use strict';
async function up(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS account_telegram_links (
    telegram_user_id BIGINT NOT NULL PRIMARY KEY,
    chat_id BIGINT NOT NULL,
    username VARCHAR(64) NULL,
    first_name VARCHAR(150) NULL,
    first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_account_link_chat(chat_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await db.query(`CREATE TABLE IF NOT EXISTS web_accounts (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    phone VARCHAR(25) NOT NULL,
    telegram_user_id BIGINT NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_web_account_phone(phone),
    UNIQUE KEY uq_web_account_telegram(telegram_user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await db.query(`CREATE TABLE IF NOT EXISTS password_reset_requests (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    account_id BIGINT UNSIGNED NOT NULL,
    phone VARCHAR(25) NOT NULL,
    telegram_user_id BIGINT NOT NULL,
    chat_id BIGINT NOT NULL,
    status ENUM('pending','approved','rejected','completed','expired') NOT NULL DEFAULT 'pending',
    reviewed_by VARCHAR(64) NULL,
    reviewed_at DATETIME NULL,
    completed_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_reset_request_status(status,created_at),
    CONSTRAINT fk_reset_request_account FOREIGN KEY(account_id) REFERENCES web_accounts(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const [resetColumns] = await db.execute("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='password_reset_requests'");
  const resetColumnNames = new Set(resetColumns.map(row => row.COLUMN_NAME));
  if (!resetColumnNames.has('delivery_status')) await db.query("ALTER TABLE password_reset_requests ADD COLUMN delivery_status ENUM('not_required','pending','sent','failed') NOT NULL DEFAULT 'not_required' AFTER status");
  if (!resetColumnNames.has('delivery_error')) await db.query("ALTER TABLE password_reset_requests ADD COLUMN delivery_error VARCHAR(500) NULL AFTER delivery_status");
  await db.query(`CREATE TABLE IF NOT EXISTS account_reset_tokens (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    request_id BIGINT UNSIGNED NOT NULL,
    account_id BIGINT UNSIGNED NOT NULL,
    token_hash CHAR(64) NOT NULL,
    expires_at DATETIME NOT NULL,
    used_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_account_reset_token_hash(token_hash),
    KEY idx_account_reset_expiry(expires_at),
    CONSTRAINT fk_account_reset_request FOREIGN KEY(request_id) REFERENCES password_reset_requests(id) ON DELETE RESTRICT,
    CONSTRAINT fk_account_reset_account FOREIGN KEY(account_id) REFERENCES web_accounts(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  return {ok:true,feature:'telegram-account-recovery'};
}
module.exports={up};
