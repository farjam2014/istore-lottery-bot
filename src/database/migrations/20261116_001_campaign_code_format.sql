-- Preserve every previously issued code. Existing codes keep their public value;
-- a deterministic internal sequence is backfilled for future counter continuity.
ALTER TABLE campaign_codes
  ADD COLUMN sequence_number INT UNSIGNED NULL AFTER campaign_id;

UPDATE campaign_codes AS cc
JOIN (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY campaign_id ORDER BY id) AS row_number_in_campaign
  FROM campaign_codes
) AS ranked ON ranked.id = cc.id
SET cc.sequence_number = 10000 + ranked.row_number_in_campaign;

ALTER TABLE campaign_codes
  MODIFY COLUMN sequence_number INT UNSIGNED NOT NULL,
  ADD UNIQUE KEY uq_campaign_code_sequence (campaign_id, sequence_number);

CREATE TABLE campaign_code_counters (
  campaign_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  next_sequence_number INT UNSIGNED NOT NULL DEFAULT 10001,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_code_counter_campaign
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO campaign_code_counters (campaign_id, next_sequence_number)
SELECT c.id, 10001 + COUNT(cc.id)
FROM campaigns AS c
LEFT JOIN campaign_codes AS cc ON cc.campaign_id = c.id
GROUP BY c.id;
