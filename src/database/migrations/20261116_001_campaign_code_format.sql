-- One-time cleanup of disposable campaign test transactions.
-- Preserve campaign definitions and participant profiles; clear participation/payment/draw records.
-- MySQL DDL is not transactional. DML is ordered child-first to satisfy foreign keys.

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

DELETE FROM campaign_codes;
DELETE FROM campaign_entries;

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
