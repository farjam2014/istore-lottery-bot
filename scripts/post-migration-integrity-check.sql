-- POST-MIGRATION integrity checks for the UStore release.
-- Run only after the versioned migration runner has completed and the baseline
-- production-migration-preflight.sql has reported the expected migration state.
-- Use a read-only MySQL account. This file contains SELECT statements only.

-- Prepared draw encryption metadata. Never select or print encryption key material.
SELECT id, campaign_id, status, algorithm, seed_key_id, seed_hash,
       CASE WHEN seed_key_id IS NULL OR LENGTH(TRIM(seed_key_id))=0
            THEN 'MISSING' ELSE 'PRESENT' END AS key_id_status,
       CASE WHEN seed_ciphertext IS NULL OR LENGTH(TRIM(seed_ciphertext))=0
            THEN 'MISSING' ELSE 'PRESENT' END AS ciphertext_status,
       CASE WHEN seed_nonce IS NULL OR LENGTH(seed_nonce)<>24
            THEN 'MISSING_OR_INVALID' ELSE 'PRESENT' END AS nonce_status,
       CASE WHEN seed_tag IS NULL OR LENGTH(seed_tag)<>32
            THEN 'MISSING_OR_INVALID' ELSE 'PRESENT' END AS tag_status,
       CASE WHEN algorithm IS NULL OR algorithm<>'HMAC-SHA256 candidate-commitment-rank-v2'
            THEN 'UNSUPPORTED' ELSE 'SUPPORTED' END AS algorithm_status
FROM campaign_draws
WHERE status='prepared'
ORDER BY id;

-- Key IDs are identifiers, not key material. Compare with the protected keyring inventory.
SELECT seed_key_id, COUNT(*) AS prepared_draw_count
FROM campaign_draws
WHERE status='prepared'
GROUP BY seed_key_id
ORDER BY seed_key_id;

-- Counter drift can make future code issuance fail on the unique sequence constraint.
SELECT c.id AS campaign_id,
       COALESCE(counter.last_sequence,0) AS counter_last_sequence,
       COALESCE(MAX(cc.sequence_number),0) AS max_existing_sequence,
       SUM(CASE WHEN cc.id IS NOT NULL AND cc.sequence_number IS NULL THEN 1 ELSE 0 END) AS missing_sequence_count
FROM campaigns c
LEFT JOIN campaign_code_counters counter ON counter.campaign_id=c.id
LEFT JOIN campaign_codes cc ON cc.campaign_id=c.id
GROUP BY c.id,counter.last_sequence
HAVING COALESCE(counter.last_sequence,0)<COALESCE(MAX(cc.sequence_number),0)
    OR (counter.last_sequence IS NULL AND COUNT(cc.id)>0)
    OR SUM(CASE WHEN cc.id IS NOT NULL AND cc.sequence_number IS NULL THEN 1 ELSE 0 END)>0
ORDER BY c.id;

-- Duplicate sequence values should be impossible after migration 001.
SELECT campaign_id, sequence_number, COUNT(*) AS duplicate_count
FROM campaign_codes
WHERE sequence_number IS NOT NULL
GROUP BY campaign_id,sequence_number
HAVING COUNT(*)>1
ORDER BY campaign_id,sequence_number;
