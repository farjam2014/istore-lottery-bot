-- READ-ONLY production migration preflight.
-- Run against the intended database with a read-only MySQL account.
-- This file contains SELECT statements only. It does not alter schema or data.

SELECT 'database' AS check_name, DATABASE() AS database_name, @@hostname AS mysql_host, VERSION() AS mysql_version;

-- Exact row counts. These replace InnoDB estimated_rows from TABLES.
SELECT 'campaigns' AS table_name, COUNT(*) AS exact_rows FROM campaigns
UNION ALL SELECT 'campaign_entries', COUNT(*) FROM campaign_entries
UNION ALL SELECT 'participants', COUNT(*) FROM participants
UNION ALL SELECT 'campaign_codes', COUNT(*) FROM campaign_codes
UNION ALL SELECT 'campaign_draws', COUNT(*) FROM campaign_draws
UNION ALL SELECT 'draw_candidates', COUNT(*) FROM draw_candidates
UNION ALL SELECT 'draw_winners', COUNT(*) FROM draw_winners
UNION ALL SELECT 'payment_orders', COUNT(*) FROM payment_orders
UNION ALL SELECT 'payment_receipts', COUNT(*) FROM payment_receipts
UNION ALL SELECT 'payment_events', COUNT(*) FROM payment_events
UNION ALL SELECT 'processed_updates', COUNT(*) FROM processed_updates
UNION ALL SELECT 'telegram_rate_limits', COUNT(*) FROM telegram_rate_limits
UNION ALL SELECT 'telegram_notification_outbox', COUNT(*) FROM telegram_notification_outbox
ORDER BY table_name;

-- Telegram inbox table presence. This query is safe before migration 002.
SELECT 'telegram_update_inbox' AS table_name, COUNT(*) AS table_exists
FROM information_schema.TABLES
WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='telegram_update_inbox';

-- Admin idempotency table presence.
SELECT 'admin_action_idempotency' AS table_name, COUNT(*) AS table_exists
FROM information_schema.TABLES
WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='admin_action_idempotency';

-- Exact campaign code ownership mismatches. Migration 001 adds a composite
-- FK from (campaign_entry_id,campaign_id) to campaign_entries(id,campaign_id).
SELECT COUNT(*) AS campaign_code_entry_campaign_mismatches
FROM campaign_codes cc
JOIN campaign_entries ce ON ce.id=cc.campaign_entry_id
WHERE cc.campaign_id<>ce.campaign_id;

-- Campaigns over the supported sequence limit must be resolved before migration 001.
SELECT campaign_id, COUNT(*) AS existing_code_count
FROM campaign_codes
GROUP BY campaign_id
HAVING COUNT(*) > 999999;

-- Legacy draw evidence blocks migration 006. The migration deliberately refuses
-- to infer historical entry/participant/code snapshots for any existing rows.
-- Any non-zero count requires explicit reconciliation before release.
SELECT COUNT(*) AS candidate_draw_code_campaign_mismatches
FROM draw_candidates dc
JOIN campaign_draws d ON d.id=dc.draw_id
JOIN campaign_codes cc ON cc.id=dc.campaign_code_id
WHERE d.campaign_id<>cc.campaign_id;

SELECT COUNT(*) AS winner_draw_code_campaign_mismatches
FROM draw_winners dw
JOIN campaign_draws d ON d.id=dw.draw_id
JOIN campaign_codes cc ON cc.id=dw.campaign_code_id
WHERE d.campaign_id<>cc.campaign_id;

SELECT 'draw_rows_blocking_migration_006' AS check_name,
       (SELECT COUNT(*) FROM draw_candidates) AS candidate_rows,
       (SELECT COUNT(*) FROM draw_winners) AS winner_rows;

-- Prepared draws need special handling: the old schema stores seed_hash only.
-- Do not cancel/recreate these draws or assume the seed can be recovered.
SELECT status, COUNT(*) AS draw_count
FROM campaign_draws
GROUP BY status
ORDER BY status;

SELECT id, campaign_id, status, algorithm, seed_hash, created_at
FROM campaign_draws
WHERE status='prepared'
ORDER BY id;

-- Migration history and presence of all fourteen release migrations.
SELECT version, checksum, applied_at
FROM schema_migrations
ORDER BY version;

SELECT expected.version,
       CASE WHEN actual.version IS NULL THEN 'MISSING' ELSE 'APPLIED' END AS migration_status,
       actual.checksum AS recorded_checksum,
       actual.applied_at
FROM (
  SELECT '20261117_001_campaign_code_sequence.sql' AS version
  UNION ALL SELECT '20261117_002_admin_campaign_code_search.sql'
  UNION ALL SELECT '20261117_003_verifiable_campaign_draws.sql'
  UNION ALL SELECT '20261117_004_draw_commitment_publication.sql'
  UNION ALL SELECT '20261117_005_draw_seed_keyring.sql'
  UNION ALL SELECT '20261117_006_draw_relational_integrity.sql'
  UNION ALL SELECT '20261118_001_participant_search_state.sql'
  UNION ALL SELECT '20261118_002_paid_code_quantity.sql'
  UNION ALL SELECT '20261119_001_campaign_edit_wizard_step.sql'
  UNION ALL SELECT '20261119_002_telegram_update_inbox.sql'
  UNION ALL SELECT '20261124_001_admin_action_idempotency.sql'
  UNION ALL SELECT '20261124_002_privacy_consent.sql'
  UNION ALL SELECT '20261124_003_registration_session_replay.sql'
  UNION ALL SELECT '20261124_004_admin_wizard_replay.sql'
) expected
LEFT JOIN schema_migrations actual ON actual.version=expected.version
ORDER BY expected.version;

-- Current schema capabilities required by the new application.
SELECT table_name, column_name, column_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema=DATABASE()
  AND (
    (table_name='campaign_codes' AND column_name IN ('sequence_number','random_prefix','random_suffix','format_version','status'))
    OR (table_name='campaign_draws' AND column_name IN ('winner_count','seed_ciphertext','seed_nonce','seed_tag','seed_key_id','revealed_seed','candidate_snapshot_hash','commitment_publication_reference','commitment_published_at','commitment_published_by'))
    OR (table_name='draw_candidates' AND column_name IN ('campaign_id','participant_id','code_snapshot'))
    OR (table_name='draw_winners' AND column_name IN ('campaign_id','participant_id','candidate_id','code_snapshot'))
    OR (table_name='campaign_code_counters' AND column_name='campaign_id')
    OR (table_name='admin_search_sessions' AND column_name IN ('campaign_id','step','query_text'))
    OR (table_name='payment_orders' AND column_name='requested_code_count')
    OR (table_name='admin_wizards' AND column_name='step')
    OR (table_name='admin_wizards' AND column_name='last_update_id')
    OR (table_name='telegram_user_sessions' AND column_name='last_update_id')
    OR (table_name='participants' AND column_name IN ('privacy_consent_version','privacy_consent_at'))
    OR (table_name='admin_action_idempotency' AND column_name IN ('idempotency_key','action_type','actor_telegram_id','entity_id','created_at'))
    OR (table_name='telegram_update_inbox' AND column_name IN ('update_id','payload','status','attempts','available_at','locked_at','lease_token','completed_at','last_error'))
  )
ORDER BY table_name, ordinal_position;

-- Existing foreign-key definitions relevant to the migration.
SELECT table_name, constraint_name, column_name, referenced_table_name,
       referenced_column_name, ordinal_position
FROM information_schema.key_column_usage
WHERE table_schema=DATABASE()
  AND table_name IN ('campaign_entries','campaign_codes','campaign_draws','draw_candidates','draw_winners')
  AND referenced_table_name IS NOT NULL
ORDER BY table_name, constraint_name, ordinal_position;
