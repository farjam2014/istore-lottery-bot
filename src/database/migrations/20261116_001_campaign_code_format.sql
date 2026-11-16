-- One-time cleanup of disposable campaign test transactions.
-- Preserve campaign definitions and participant profiles; clear participation/payment/draw records.
-- MySQL DDL below is not transactional. Cleanup DML is deliberately ordered by foreign keys.

CREATE TEMPORARY TABLE cleanup_campaign_entries (
  id BIGINT UNSIGNED NOT NULL PRIMARY KEY
) ENGINE=InnoDB
AS SELECT id FROM campaign_entries;

CREATE TEMPORARY TABLE cleanup_payment_orders (
  id BIGINT UNSIGNED NOT NULL PRIMARY KEY
) ENGINE=InnoDB
AS SELECT id FROM payment_orders
WHERE campaign_entry_id IN (SELECT id FROM cleanup_campaign_entries);

CREATE TEMPORARY TABLE cleanup_draws (
  id BIGINT UNSIGNED NOT NULL PRIMARY KEY
) ENGINE=InnoDB
AS
SELECT DISTINCT draw_id FROM draw_candidates
WHERE campaign_code_id IN (SELECT id FROM campaign_codes)
UNION
SELECT DISTINCT draw_id FROM draw_winners
WHERE campaign_code_id IN (SELECT id FROM campaign_codes);

-- Remove child records before their parents.
DELETE FROM draw_candidates
WHERE campaign_code_id IN (SELECT id FROM campaign_codes);

DELETE FROM draw_winners
WHERE campaign_code_id IN (SELECT id FROM campaign_codes);

DELETE FROM campaign_draws
WHERE id IN (SELECT id FROM cleanup_draws);

DELETE FROM payment_receipts
WHERE order_id IN (SELECT id FROM cleanup_payment_orders);

DELETE FROM payment_events
WHERE order_id IN (SELECT id FROM cleanup_payment_orders);

DELETE FROM payment_orders
WHERE id IN (SELECT id FROM cleanup_payment_orders);

DELETE FROM campaign_codes;

DELETE FROM campaign_entries
WHERE id IN (SELECT id FROM cleanup_campaign_entries);

DROP TEMPORARY TABLE cleanup_draws;
DROP TEMPORARY TABLE cleanup_payment_orders;
DROP TEMPORARY TABLE cleanup_campaign_entries;

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

-- Every campaign starts clean. Its first new code will use sequence 10001.
INSERT INTO campaign_code_counters (campaign_id, next_sequence_number)
SELECT id, 10001
FROM campaigns;
