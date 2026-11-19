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
  last_sequence INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_code_counter_campaign FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  CONSTRAINT chk_code_counter_range CHECK(last_sequence BETWEEN 0 AND 999999)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Preserve legacy codes as format version 1 while assigning stable per-campaign
-- sequence numbers in original issuance order. New codes start after this sequence.
UPDATE campaign_codes cc
JOIN (
  SELECT id, ROW_NUMBER() OVER(PARTITION BY campaign_id ORDER BY id) AS legacy_sequence
  FROM campaign_codes
) ranked ON ranked.id=cc.id
SET cc.sequence_number=ranked.legacy_sequence,
    cc.format_version=1
WHERE cc.sequence_number IS NULL;

INSERT IGNORE INTO campaign_code_counters(campaign_id,last_sequence)
SELECT c.id,COALESCE(MAX(cc.sequence_number),0)
FROM campaigns c
LEFT JOIN campaign_codes cc ON cc.campaign_id=c.id
GROUP BY c.id;
