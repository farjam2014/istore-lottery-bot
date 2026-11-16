-- One-time cleanup of disposable campaign test transactions.
-- Preserve campaign definitions (including open campaigns) and participant profiles.
-- The DML is intentionally safe to repeat if the migration runner stops before
-- recording the version. MySQL DDL is not transactional, so each schema change
-- below is guarded through information_schema and can also be resumed.

-- Draw data is wholly test-only at this stage. Remove children before draw records.
DELETE FROM draw_candidates;
DELETE FROM draw_winners;
DELETE FROM campaign_draws;

-- Clear payment artifacts belonging to campaign entries before deleting the orders.
DELETE FROM payment_receipts
WHERE order_id IN (
  SELECT id FROM payment_orders
  WHERE campaign_entry_id IN (SELECT id FROM campaign_entries)
);

DELETE FROM payment_events
WHERE order_id IN (
  SELECT id FROM payment_orders
  WHERE campaign_entry_id IN (SELECT id FROM campaign_entries)
);

DELETE FROM payment_orders
WHERE campaign_entry_id IN (SELECT id FROM campaign_entries);

-- All previously issued campaign codes and campaign participation rows are disposable test data.
DELETE FROM campaign_codes;
DELETE FROM campaign_entries;

-- MySQL 8.0 does not consistently support ADD COLUMN IF NOT EXISTS.
-- Check metadata and execute a no-op when the column already exists.
SET @campaign_code_has_sequence_column := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'campaign_codes'
    AND COLUMN_NAME = 'sequence_number'
);
SET @campaign_code_add_sequence_sql := IF(
  @campaign_code_has_sequence_column = 0,
  'ALTER TABLE campaign_codes ADD COLUMN sequence_number INT UNSIGNED NOT NULL AFTER campaign_id',
  'SELECT 1'
);
PREPARE campaign_code_add_sequence_stmt FROM @campaign_code_add_sequence_sql;
EXECUTE campaign_code_add_sequence_stmt;
DEALLOCATE PREPARE campaign_code_add_sequence_stmt;

-- Guard the unique index as well, so a retry after partial DDL can continue.
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

-- INSERT IGNORE makes a retry safe and never resets an existing counter.
INSERT IGNORE INTO campaign_code_counters (campaign_id, next_sequence_number)
SELECT id, 10001
FROM campaigns;
