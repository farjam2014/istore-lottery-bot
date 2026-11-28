-- READ-ONLY production migration preflight.
-- Run against the intended database with a read-only MySQL account.
-- Uses read-only SELECTs (including conditionally prepared SELECTs); no DDL/DML or data changes.

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

-- Rate-limit table presence (created by a later migration).
SELECT 'telegram_rate_limits' AS table_name, COUNT(*) AS table_exists
FROM information_schema.TABLES
WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='telegram_rate_limits';

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

-- Draw mismatch checks require migration 003's relational snapshot columns.
-- Use prepared SELECTs so this script also runs before that migration.
SET @has_candidate_campaign_id := (
  SELECT COUNT(*)=1 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='draw_candidates' AND COLUMN_NAME='campaign_id'
);
SET @preflight_sql := IF(
  @has_candidate_campaign_id,
  'SELECT COUNT(*) AS candidate_draw_code_campaign_mismatches FROM draw_candidates dc JOIN campaign_draws d ON d.id=dc.draw_id JOIN campaign_codes cc ON cc.id=dc.campaign_code_id WHERE d.campaign_id<>cc.campaign_id',
  'SELECT ''PENDING_MIGRATION_003'' AS check_status, NULL AS candidate_draw_code_campaign_mismatches'
);
PREPARE preflight_stmt FROM @preflight_sql;
EXECUTE preflight_stmt;
DEALLOCATE PREPARE preflight_stmt;

SET @has_winner_campaign_id := (
  SELECT COUNT(*)=1 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='draw_winners' AND COLUMN_NAME='campaign_id'
);
SET @preflight_sql := IF(
  @has_winner_campaign_id,
  'SELECT COUNT(*) AS winner_draw_code_campaign_mismatches FROM draw_winners dw JOIN campaign_draws d ON d.id=dw.draw_id JOIN campaign_codes cc ON cc.id=dw.campaign_code_id WHERE d.campaign_id<>cc.campaign_id',
  'SELECT ''PENDING_MIGRATION_003'' AS check_status, NULL AS winner_draw_code_campaign_mismatches'
);
PREPARE preflight_stmt FROM @preflight_sql;
EXECUTE preflight_stmt;
DEALLOCATE PREPARE preflight_stmt;

-- Legacy draw evidence blocks migration 006. migrate.js independently enforces
-- empty draw tables before its deterministic no-op backfill statements.
SELECT 'draw_rows_blocking_migration_006' AS check_name,
       (SELECT COUNT(*) FROM draw_candidates) AS candidate_rows,
       (SELECT COUNT(*) FROM draw_winners) AS winner_rows;

-- Prepared draws on the baseline schema only expose seed_hash and metadata.
SELECT status, COUNT(*) AS draw_count
FROM campaign_draws
GROUP BY status
ORDER BY status;

SELECT id, campaign_id, status, algorithm, seed_hash, created_at
FROM campaign_draws
WHERE status='prepared'
ORDER BY id;

-- Migration history and presence of all 28 release migrations.
SELECT version, checksum, applied_at
FROM schema_migrations
ORDER BY version;

SELECT expected.version,
       CASE WHEN actual.version IS NULL THEN 'MISSING' ELSE 'APPLIED' END AS migration_status,
       actual.checksum AS recorded_checksum,
       actual.applied_at
FROM (
  SELECT '20261114_001_payment_expiry_reference.sql' AS version
  UNION ALL SELECT '20261114_002_campaign_details.sql'
  UNION ALL SELECT '20261114_003_support_tickets.sql'
  UNION ALL SELECT '20261114_004_admin_roles.sql'
  UNION ALL SELECT '20261114_005_payment_admin_sessions.sql'
  UNION ALL SELECT '20261114_006_admin_search_and_rate_limits.sql'
  UNION ALL SELECT '20261114_007_profile_change_sessions.sql'
  UNION ALL SELECT '20261114_008_outbox_uncertain_delivery.sql'
  UNION ALL SELECT '20261115-payment-bank-cards.sql'
  UNION ALL SELECT '20261115_009_correlation_and_delivery_history.sql'
  UNION ALL SELECT '20261117_001_campaign_code_sequence.sql'
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
  UNION ALL SELECT '20261125_001_support_reply_replay.sql'
  UNION ALL SELECT '20261125_002_admin_search_replay.sql'
  UNION ALL SELECT '20261125_003_participant_session_replay.sql'
  UNION ALL SELECT '20261125_004_admin_audit_append_only.sql'
) expected
LEFT JOIN schema_migrations actual ON actual.version=expected.version
ORDER BY expected.version;

-- Privacy and replay/audit records: aggregate counts only; never select personal payloads.
-- Telegram Update JSON can contain personal data, so only the row count is emitted.
SET @preflight_session_table_exists := (
  SELECT COUNT(*)=1 FROM information_schema.TABLES
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='telegram_update_inbox'
);
SET @preflight_sql := IF(
  @preflight_session_table_exists,
  'SELECT ''telegram_update_inbox'' AS table_name, COUNT(*) AS exact_rows, ''PRESENT'' AS check_status FROM telegram_update_inbox',
  'SELECT ''telegram_update_inbox'' AS table_name, NULL AS exact_rows, ''PENDING_OR_MISSING_TABLE'' AS check_status'
);
PREPARE preflight_session_stmt FROM @preflight_sql;
EXECUTE preflight_session_stmt;
DEALLOCATE PREPARE preflight_session_stmt;

-- Count legacy inbox error values without exposing their contents. Older releases
-- may have persisted raw exception text; current releases use fixed labels only.
SET @preflight_inbox_error_column_exists := (
  SELECT COUNT(*)=1 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='telegram_update_inbox' AND COLUMN_NAME='last_error'
);
SET @preflight_sql := IF(
  @preflight_inbox_error_column_exists,
  'SELECT ''telegram_update_inbox_legacy_error_rows'' AS metric, COUNT(*) AS exact_rows, ''PRESENT'' AS check_status FROM telegram_update_inbox WHERE last_error IS NOT NULL AND last_error NOT IN (''invalid_payload'',''payload_update_id_mismatch'',''handler_failed'')',
  'SELECT ''telegram_update_inbox_legacy_error_rows'' AS metric, NULL AS exact_rows, ''PENDING_OR_MISSING_COLUMN'' AS check_status'
);
PREPARE preflight_session_stmt FROM @preflight_sql;
EXECUTE preflight_session_stmt;
DEALLOCATE PREPARE preflight_session_stmt;

SET @preflight_session_table_exists := (
  SELECT COUNT(*)=1 FROM information_schema.TABLES
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='admin_action_idempotency'
);
SET @preflight_sql := IF(
  @preflight_session_table_exists,
  'SELECT ''admin_action_idempotency'' AS table_name, COUNT(*) AS exact_rows, ''PRESENT'' AS check_status FROM admin_action_idempotency',
  'SELECT ''admin_action_idempotency'' AS table_name, NULL AS exact_rows, ''PENDING_OR_MISSING_TABLE'' AS check_status'
);
PREPARE preflight_session_stmt FROM @preflight_sql;
EXECUTE preflight_session_stmt;
DEALLOCATE PREPARE preflight_session_stmt;

-- Outbox inventory is aggregate-only: never select chat IDs, payload text, file IDs,
-- or callback data. Payload byte counts support a retention decision without disclosure.
SET @preflight_outbox_table_exists := (
  SELECT COUNT(*)=1 FROM information_schema.TABLES
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='telegram_notification_outbox'
);
SET @preflight_sql := IF(
  @preflight_outbox_table_exists,
  'SELECT status, COUNT(*) AS exact_rows, COALESCE(SUM(OCTET_LENGTH(payload)),0) AS payload_bytes, ''PRESENT'' AS check_status FROM telegram_notification_outbox GROUP BY status ORDER BY status',
  'SELECT ''PENDING_OR_MISSING_TABLE'' AS check_status, NULL AS status, NULL AS exact_rows, NULL AS payload_bytes'
);
PREPARE preflight_session_stmt FROM @preflight_sql;
EXECUTE preflight_session_stmt;
DEALLOCATE PREPARE preflight_session_stmt;

SET @preflight_outbox_error_column_exists := (
  SELECT COUNT(*)=1 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='telegram_notification_outbox' AND COLUMN_NAME='last_error'
);
SET @preflight_sql := IF(
  @preflight_outbox_error_column_exists,
  'SELECT ''telegram_notification_outbox_legacy_error_rows'' AS metric, COUNT(*) AS exact_rows, ''PRESENT'' AS check_status FROM telegram_notification_outbox WHERE last_error IS NOT NULL AND last_error NOT IN (''invalid_payload'',''telegram_http_429'',''telegram_http_408_timeout'',''telegram_http_4xx'',''telegram_http_5xx'',''network_or_unknown'',''manually_requeued'',''legacy_error_redacted'',''Delivery outcome unknown after worker lease expired'')',
  'SELECT ''telegram_notification_outbox_legacy_error_rows'' AS metric, NULL AS exact_rows, ''PENDING_OR_MISSING_COLUMN'' AS check_status'
);
PREPARE preflight_session_stmt FROM @preflight_sql;
EXECUTE preflight_session_stmt;
DEALLOCATE PREPARE preflight_session_stmt;

-- Consent-state breakdown is aggregate-only and safe before migration 002.
SET @preflight_privacy_columns_exist := (
  SELECT COUNT(*)=2 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='participants'
    AND COLUMN_NAME IN ('privacy_consent_version','privacy_consent_at')
);
SET @preflight_sql := IF(
  @preflight_privacy_columns_exist,
  'SELECT COALESCE(privacy_consent_version,''<NULL>'') AS consent_version, COUNT(*) AS participant_count, SUM(privacy_consent_at IS NULL) AS missing_acceptance_timestamp_count FROM participants GROUP BY privacy_consent_version ORDER BY privacy_consent_version',
  'SELECT ''PENDING_MIGRATION_002'' AS check_status, NULL AS consent_version, NULL AS participant_count, NULL AS missing_acceptance_timestamp_count'
);
PREPARE preflight_session_stmt FROM @preflight_sql;
EXECUTE preflight_session_stmt;
DEALLOCATE PREPARE preflight_session_stmt;

-- Exact impact inventory for legacy session rows affected by replay migrations.
-- Missing tables are reported as pending prerequisite migrations, never silently treated as zero.

-- registration sessions cleared by 20261124_003.
SET @preflight_session_table_exists := (
  SELECT COUNT(*)=1 FROM information_schema.TABLES
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='telegram_user_sessions'
);
SET @preflight_sql := IF(
  @preflight_session_table_exists,
  'SELECT ''telegram_user_sessions'' AS table_name, COUNT(*) AS exact_rows, ''PRESENT'' AS check_status FROM telegram_user_sessions',
  'SELECT ''telegram_user_sessions'' AS table_name, NULL AS exact_rows, ''PENDING_OR_MISSING_TABLE'' AS check_status'
);
PREPARE preflight_session_stmt FROM @preflight_sql;
EXECUTE preflight_session_stmt;
DEALLOCATE PREPARE preflight_session_stmt;

-- admin wizard sessions cleared by 20261124_004.
SET @preflight_session_table_exists := (
  SELECT COUNT(*)=1 FROM information_schema.TABLES
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='admin_wizards'
);
SET @preflight_sql := IF(
  @preflight_session_table_exists,
  'SELECT ''admin_wizards'' AS table_name, COUNT(*) AS exact_rows, ''PRESENT'' AS check_status FROM admin_wizards',
  'SELECT ''admin_wizards'' AS table_name, NULL AS exact_rows, ''PENDING_OR_MISSING_TABLE'' AS check_status'
);
PREPARE preflight_session_stmt FROM @preflight_sql;
EXECUTE preflight_session_stmt;
DEALLOCATE PREPARE preflight_session_stmt;

-- payment-card wizard sessions cleared by 20261124_004.
SET @preflight_session_table_exists := (
  SELECT COUNT(*)=1 FROM information_schema.TABLES
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='payment_card_admin_sessions'
);
SET @preflight_sql := IF(
  @preflight_session_table_exists,
  'SELECT ''payment_card_admin_sessions'' AS table_name, COUNT(*) AS exact_rows, ''PRESENT'' AS check_status FROM payment_card_admin_sessions',
  'SELECT ''payment_card_admin_sessions'' AS table_name, NULL AS exact_rows, ''PENDING_OR_MISSING_TABLE'' AS check_status'
);
PREPARE preflight_session_stmt FROM @preflight_sql;
EXECUTE preflight_session_stmt;
DEALLOCATE PREPARE preflight_session_stmt;

-- admin-role wizard sessions cleared by 20261124_004.
SET @preflight_session_table_exists := (
  SELECT COUNT(*)=1 FROM information_schema.TABLES
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='admin_role_sessions'
);
SET @preflight_sql := IF(
  @preflight_session_table_exists,
  'SELECT ''admin_role_sessions'' AS table_name, COUNT(*) AS exact_rows, ''PRESENT'' AS check_status FROM admin_role_sessions',
  'SELECT ''admin_role_sessions'' AS table_name, NULL AS exact_rows, ''PENDING_OR_MISSING_TABLE'' AS check_status'
);
PREPARE preflight_session_stmt FROM @preflight_sql;
EXECUTE preflight_session_stmt;
DEALLOCATE PREPARE preflight_session_stmt;

-- support sessions cleared by 20261125_001 and 20261125_003.
SET @preflight_session_table_exists := (
  SELECT COUNT(*)=1 FROM information_schema.TABLES
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='support_sessions'
);
SET @preflight_sql := IF(
  @preflight_session_table_exists,
  'SELECT ''support_sessions'' AS table_name, COUNT(*) AS exact_rows, ''PRESENT'' AS check_status FROM support_sessions',
  'SELECT ''support_sessions'' AS table_name, NULL AS exact_rows, ''PENDING_OR_MISSING_TABLE'' AS check_status'
);
PREPARE preflight_session_stmt FROM @preflight_sql;
EXECUTE preflight_session_stmt;
DEALLOCATE PREPARE preflight_session_stmt;

-- profile-change sessions cleared by 20261125_003.
SET @preflight_session_table_exists := (
  SELECT COUNT(*)=1 FROM information_schema.TABLES
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='profile_change_sessions'
);
SET @preflight_sql := IF(
  @preflight_session_table_exists,
  'SELECT ''profile_change_sessions'' AS table_name, COUNT(*) AS exact_rows, ''PRESENT'' AS check_status FROM profile_change_sessions',
  'SELECT ''profile_change_sessions'' AS table_name, NULL AS exact_rows, ''PENDING_OR_MISSING_TABLE'' AS check_status'
);
PREPARE preflight_session_stmt FROM @preflight_sql;
EXECUTE preflight_session_stmt;
DEALLOCATE PREPARE preflight_session_stmt;

-- admin_search_sessions are retained by 20261125_002 but existing rows receive a NULL cursor;
-- candidate replay guards reject these legacy in-progress searches, so users must start a new search.
SET @preflight_session_table_exists := (
  SELECT COUNT(*)=1 FROM information_schema.TABLES
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='admin_search_sessions'
);
SET @preflight_sql := IF(
  @preflight_session_table_exists,
  'SELECT ''admin_search_sessions'' AS table_name, COUNT(*) AS exact_rows, ''PRESENT'' AS check_status FROM admin_search_sessions',
  'SELECT ''admin_search_sessions'' AS table_name, NULL AS exact_rows, ''PENDING_OR_MISSING_TABLE'' AS check_status'
);
PREPARE preflight_session_stmt FROM @preflight_sql;
EXECUTE preflight_session_stmt;
DEALLOCATE PREPARE preflight_session_stmt;

-- payment_admin_sessions are retained by 20261125_002 but existing rows receive a NULL cursor;
-- candidate replay guards reject these legacy in-progress order searches, so users must start a new search.
SET @preflight_session_table_exists := (
  SELECT COUNT(*)=1 FROM information_schema.TABLES
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='payment_admin_sessions'
);
SET @preflight_sql := IF(
  @preflight_session_table_exists,
  'SELECT ''payment_admin_sessions'' AS table_name, COUNT(*) AS exact_rows, ''PRESENT'' AS check_status FROM payment_admin_sessions',
  'SELECT ''payment_admin_sessions'' AS table_name, NULL AS exact_rows, ''PENDING_OR_MISSING_TABLE'' AS check_status'
);
PREPARE preflight_session_stmt FROM @preflight_sql;
EXECUTE preflight_session_stmt;
DEALLOCATE PREPARE preflight_session_stmt;

-- Support-session step breakdown identifies the admin_reply subset removed by migration 20261125_001.
SET @preflight_sql := IF(
  (SELECT COUNT(*)=1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='support_sessions'),
  'SELECT step, COUNT(*) AS exact_rows, ''PRESENT'' AS check_status FROM support_sessions GROUP BY step ORDER BY step',
  'SELECT ''support_sessions'' AS table_name, ''PENDING_OR_MISSING_TABLE'' AS check_status, NULL AS step, NULL AS exact_rows'
);
PREPARE preflight_session_stmt FROM @preflight_sql;
EXECUTE preflight_session_stmt;
DEALLOCATE PREPARE preflight_session_stmt;

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
    OR (table_name='payment_card_admin_sessions' AND column_name='last_update_id')
    OR (table_name='support_sessions' AND column_name='last_update_id')
    OR (table_name='profile_change_sessions' AND column_name='last_update_id')
    OR (table_name='admin_search_sessions' AND column_name='last_update_id')
    OR (table_name='payment_admin_sessions' AND column_name='last_update_id')
    OR (table_name='admin_role_sessions' AND column_name='last_update_id')
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

