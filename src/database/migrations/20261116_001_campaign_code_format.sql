-- Preserve all existing campaign, payment, receipt and draw history.
-- Existing public codes remain unchanged; sequence_number is internal allocation metadata.
-- The statements are retry-safe if MySQL stops before schema_migrations records this file.

-- Add the sequence column as nullable first so existing rows can be backfilled.
SET @campaign_code_has_sequence_column := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'campaign_codes'
    AND COLUMN_NAME = 'sequence_number'
);
SET @campaign_code_add_sequence_sql := IF(
  @campaign_code_has_sequence_column = 0,
  'ALTER TABLE campaign_codes ADD COLUMN sequence_number INT UNSIGNED NULL AFTER campaign_id',
  'SELECT 1'
);
PREPARE campaign_code_add_sequence_stmt FROM @campaign_code_add_sequence_sql;
EXECUTE campaign_code_add_sequence_stmt;
DEALLOCATE PREPARE campaign_code_add_sequence_stmt;

-- Give legacy codes stable per-campaign sequence metadata without changing their public code.
-- ROW_NUMBER() makes the derived table non-mergeable on MySQL 8.
UPDATE campaign_codes AS target
JOIN (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY campaign_id ORDER BY id) AS assigned_sequence
  FROM campaign_codes
) AS ranked ON ranked.id = target.id
SET target.sequence_number = ranked.assigned_sequence
WHERE target.sequence_number IS NULL;

ALTER TABLE campaign_codes MODIFY COLUMN sequence_number INT UNSIGNED NOT NULL;

-- Guard the unique index so a retry after partial DDL can continue.
SET @campaign_code_has_sequence_index := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'campaign_codes'
    AND INDEX_NAME = 'uq_campaign_code_sequence'
);
SET @campaign_code_add_sequence_index_sql := IF(
  @campaign_code_has_sequence_index = 0,
  'ALTER TABLE campaign_codes ADD UNIQUE KEY uq_campaign_code_sequence (campaign_id, sequence_number)',
  'SELECT 1'
);
PREPARE campaign_code_add_sequence_index_stmt FROM @campaign_code_add_sequence_index_sql;
EXECUTE campaign_code_add_sequence_index_stmt;
DEALLOCATE PREPARE campaign_code_add_sequence_index_stmt;

CREATE TABLE IF NOT EXISTS campaign_code_counters (
  campaign_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  next_sequence_number INT UNSIGNED NOT NULL DEFAULT 10001,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_code_counter_campaign
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Start new-format codes at 10001, or after the highest preserved legacy sequence.
-- INSERT IGNORE makes retries safe and never resets a counter already in use.
INSERT IGNORE INTO campaign_code_counters (campaign_id, next_sequence_number)
SELECT c.id, GREATEST(10001, COALESCE(MAX(cc.sequence_number) + 1, 10001))
FROM campaigns c
LEFT JOIN campaign_codes cc ON cc.campaign_id = c.id
GROUP BY c.id;
