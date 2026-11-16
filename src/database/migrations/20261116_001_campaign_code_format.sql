-- All currently issued campaign codes are disposable test data.
-- Remove draw references first because they have foreign keys to campaign_codes.
-- Campaign entries, participants, orders, receipts and campaigns are intentionally preserved.
DELETE FROM draw_winners
WHERE campaign_code_id IN (SELECT id FROM campaign_codes);

DELETE FROM draw_candidates
WHERE campaign_code_id IN (SELECT id FROM campaign_codes);

DELETE FROM campaign_codes;

ALTER TABLE campaign_codes
  ADD COLUMN sequence_number INT UNSIGNED NOT NULL AFTER campaign_id,
  ADD UNIQUE KEY uq_campaign_code_sequence (campaign_id, sequence_number);

CREATE TABLE campaign_code_counters (
  campaign_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  next_sequence_number INT UNSIGNED NOT NULL DEFAULT 10001,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_code_counter_campaign
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every campaign starts clean. Its first newly issued code will be sequence 10001.
INSERT INTO campaign_code_counters (campaign_id, next_sequence_number)
SELECT id, 10001
FROM campaigns;
