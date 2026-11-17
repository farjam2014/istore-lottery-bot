ALTER TABLE campaign_entries
  ADD UNIQUE KEY uq_entry_id_campaign(id,campaign_id);

ALTER TABLE campaign_codes
  ADD COLUMN sequence_number INT UNSIGNED NULL AFTER code,
  ADD COLUMN random_prefix VARCHAR(5) NULL AFTER sequence_number,
  ADD COLUMN random_suffix CHAR(2) NULL AFTER random_prefix,
  ADD COLUMN format_version TINYINT UNSIGNED NOT NULL DEFAULT 1 AFTER random_suffix,
  ADD COLUMN status ENUM('active','revoked','disqualified') NOT NULL DEFAULT 'active' AFTER format_version,
  ADD UNIQUE KEY uq_campaign_sequence(campaign_id,sequence_number),
  ADD KEY idx_campaign_code_status(campaign_id,status),
  ADD CONSTRAINT fk_code_entry_campaign
    FOREIGN KEY(campaign_entry_id,campaign_id)
    REFERENCES campaign_entries(id,campaign_id);

CREATE TABLE campaign_code_counters (
  campaign_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  last_sequence INT UNSIGNED NOT NULL DEFAULT 10000,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_code_counter_campaign FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  CONSTRAINT chk_code_counter_range CHECK(last_sequence BETWEEN 10000 AND 999999)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO campaign_code_counters(campaign_id,last_sequence)
SELECT id,10000 FROM campaigns;
