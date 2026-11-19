CREATE TABLE IF NOT EXISTS payment_bank_cards (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  bank_name VARCHAR(80) NOT NULL,
  card_number CHAR(16) NOT NULL,
  card_holder VARCHAR(120) NOT NULL,
  instructions VARCHAR(500) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  default_guard TINYINT GENERATED ALWAYS AS (CASE WHEN is_default=1 THEN 1 ELSE NULL END) STORED,
  created_by BIGINT NOT NULL,
  updated_by BIGINT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_payment_bank_cards_number(card_number),
  UNIQUE KEY uq_payment_bank_cards_single_default(default_guard),
  KEY idx_payment_bank_cards_active_default(is_active,is_default,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payment_card_admin_sessions (
  telegram_user_id BIGINT NOT NULL PRIMARY KEY,
  step VARCHAR(32) NOT NULL,
  card_id BIGINT UNSIGNED NULL,
  payload JSON NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_payment_card_sessions_updated(updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO payment_bank_cards(bank_name,card_number,card_holder,instructions,is_active,is_default,created_by,updated_by)
SELECT COALESCE(NULLIF(bank_name,''),'بانک ثبت‌شده'),card_number,card_holder,instructions,1,1,updated_by,updated_by
FROM payment_settings
WHERE id=1 AND card_number REGEXP '^[0-9]{16}$' AND card_holder IS NOT NULL AND card_holder<>''
;
