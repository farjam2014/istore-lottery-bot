import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';

const preflight=readFileSync(new URL('../../scripts/production-migration-preflight.sql',import.meta.url),'utf8');

const expectedReleaseMigrations=[
  '20261114_001_payment_expiry_reference.sql',
  '20261114_002_campaign_details.sql',
  '20261114_003_support_tickets.sql',
  '20261114_004_admin_roles.sql',
  '20261114_005_payment_admin_sessions.sql',
  '20261114_006_admin_search_and_rate_limits.sql',
  '20261114_007_profile_change_sessions.sql',
  '20261114_008_outbox_uncertain_delivery.sql',
  '20261115-payment-bank-cards.sql',
  '20261115_009_correlation_and_delivery_history.sql',
  '20261117_001_campaign_code_sequence.sql',
  '20261117_002_admin_campaign_code_search.sql',
  '20261117_003_verifiable_campaign_draws.sql',
  '20261117_004_draw_commitment_publication.sql',
  '20261117_005_draw_seed_keyring.sql',
  '20261117_006_draw_relational_integrity.sql',
  '20261118_001_participant_search_state.sql',
  '20261118_002_paid_code_quantity.sql',
  '20261119_001_campaign_edit_wizard_step.sql',
  '20261119_002_telegram_update_inbox.sql',
  '20261124_001_admin_action_idempotency.sql',
  '20261124_002_privacy_consent.sql',
  '20261124_003_registration_session_replay.sql',
  '20261124_004_admin_wizard_replay.sql',
  '20261125_001_support_reply_replay.sql',
  '20261125_002_admin_search_replay.sql',
  '20261125_003_participant_session_replay.sql',
  '20261125_004_admin_audit_append_only.sql'
];

test('production migration preflight enumerates every release migration in order',()=>{
  assert.equal(expectedReleaseMigrations.length,28);
  for(const migration of expectedReleaseMigrations){
    assert.ok(preflight.includes(migration),`preflight is missing ${migration}`);
  }
});

test('production migration preflight checks current privacy and replay schema capabilities',()=>{
  for(const fragment of [
    "table_name='participants' AND column_name IN ('privacy_consent_version','privacy_consent_at')",
    "table_name='telegram_user_sessions' AND column_name='last_update_id'",
    "table_name='admin_wizards' AND column_name='step'",
    "table_name='admin_wizards' AND column_name='last_update_id'",
    "table_name='payment_card_admin_sessions' AND column_name='last_update_id'",
    "table_name='support_sessions' AND column_name='last_update_id'",
    "table_name='profile_change_sessions' AND column_name='last_update_id'",
    "table_name='admin_search_sessions' AND column_name='last_update_id'",
    "table_name='payment_admin_sessions' AND column_name='last_update_id'",
    "table_name='admin_role_sessions' AND column_name='last_update_id'",
    "table_name='admin_action_idempotency' AND column_name IN ('idempotency_key','action_type','actor_telegram_id','entity_id','created_at')"
  ]){
    assert.ok(preflight.includes(fragment),`preflight is missing schema capability check: ${fragment}`);
  }
});

test('production preflight reports privacy, Telegram inbox, notification Outbox, and idempotency aggregates without exposing payloads',()=>{
  for(const fragment of [
    "SELECT ''telegram_update_inbox'' AS table_name, COUNT(*) AS exact_rows",
    "SELECT ''telegram_update_inbox_legacy_error_rows'' AS metric, COUNT(*) AS exact_rows",
    "last_error NOT IN (''invalid_payload'',''payload_update_id_mismatch'',''handler_failed'')",
    "SELECT ''admin_action_idempotency'' AS table_name, COUNT(*) AS exact_rows",
    "SELECT status, COUNT(*) AS exact_rows, COALESCE(SUM(OCTET_LENGTH(payload)),0) AS payload_bytes",
    "SELECT ''telegram_notification_outbox_legacy_error_rows'' AS metric, COUNT(*) AS exact_rows",
    "last_error NOT IN (''invalid_payload'',''telegram_http_429'',''telegram_http_4xx'',''telegram_http_5xx'',''network_or_unknown'',''manually_requeued'',''legacy_error_redacted'",
    "SUM(privacy_consent_at IS NULL) AS missing_acceptance_timestamp_count",
    "PENDING_MIGRATION_002",
    "PENDING_OR_MISSING_TABLE"
  ]){
    assert.ok(preflight.includes(fragment),'preflight is missing aggregate impact check: '+fragment);
  }
  assert.doesNotMatch(preflight,/SELECT\s+(?:payload|last_error|\*)\s+FROM\s+telegram_update_inbox/i);
  assert.doesNotMatch(preflight,/SELECT\s+(?:payload|last_error|\*)\s+FROM\s+telegram_notification_outbox/i);
});

test('production preflight reports exact row counts for every replay-cleanup session table',()=>{
  for(const table of [
    'telegram_user_sessions',
    'admin_wizards',
    'payment_card_admin_sessions',
    'admin_role_sessions',
    'support_sessions',
    'profile_change_sessions',
    'admin_search_sessions',
    'payment_admin_sessions'
  ]){
    assert.ok(preflight.includes(`TABLE_NAME='${table}'`),`preflight must check whether ${table} exists`);
    assert.ok(preflight.includes(`SELECT ''${table}'' AS table_name, COUNT(*) AS exact_rows`),`preflight must count ${table} rows exactly`);
  }
  assert.match(preflight,/FROM support_sessions GROUP BY step/);
  assert.match(preflight,/PENDING_OR_MISSING_TABLE/);
});

test('baseline preflight gates migration-added tables and columns before querying them',()=>{
  assert.match(preflight,/TABLE_NAME='telegram_rate_limits'/);
  assert.doesNotMatch(preflight,/seed_ciphertext IS NULL|counter\.last_sequence|MAX\(cc\.sequence_number\)/);
  assert.match(preflight,/PREPARE preflight_stmt FROM @preflight_sql/);
  assert.match(preflight,/PENDING_MIGRATION_003/);
  assert.match(preflight,/information_schema\.COLUMNS[\s\S]*?TABLE_NAME='draw_candidates'[\s\S]*?COLUMN_NAME='campaign_id'/);
  assert.match(preflight,/information_schema\.COLUMNS[\s\S]*?TABLE_NAME='draw_winners'[\s\S]*?COLUMN_NAME='campaign_id'/);
});

test('MySQL migration history and replay fixtures include each admin wizard migration once',()=>{
  const mysqlIntegration=readFileSync(new URL('../integration/mysql.test.js',import.meta.url),'utf8');
  const history=mysqlIntegration.split('// Verify the current migration set')[1]?.split(']){')[0]||'';
  const replay=mysqlIntegration.split('// Simulate DDL committed but migration history not recorded')[1]?.split(']){')[0]||'';
  for(const [label,section] of [['history',history],['replay',replay]]){
    assert.ok(section,'Missing '+label+' migration fixture.');
    for(const migration of ['20261124_003_registration_session_replay.sql','20261124_004_admin_wizard_replay.sql','20261125_001_support_reply_replay.sql','20261125_002_admin_search_replay.sql','20261125_003_participant_session_replay.sql']){
      assert.equal(section.split(migration).length-1,1,label+' fixture must include '+migration+' exactly once.');
    }
  }
});

test('release readiness inventory lists every SQL migration in the repository',()=>{
  const migrations=readdirSync(new URL('../../src/database/migrations/',import.meta.url))
    .filter(name=>name.endsWith('.sql'))
    .sort();
  const readiness=readFileSync(new URL('../../docs/RELEASE_READINESS.md',import.meta.url),'utf8');
  assert.equal(migrations.length,28,'Update the release-readiness inventory when adding or removing migrations.');
  for(const migration of migrations){
    assert.ok(readiness.includes('`'+migration+'`'),'Release readiness inventory is missing '+migration);
  }
});

test('production host preflight is read-only and included in the release runbook',()=>{
  const hostAudit=readFileSync(new URL('../../scripts/production-host-preflight.sh',import.meta.url),'utf8');
  const runbook=readFileSync(new URL('../../docs/PRODUCTION_STAGED_DEPLOYMENT.md',import.meta.url),'utf8');
  assert.match(hostAudit,/Read-only host-side release gate inventory/);
  assert.match(hostAudit,/encrypted_database_backup_artifacts/);
  assert.match(hostAudit,/runner_unit_files=none_detected/);
  assert.match(hostAudit,/runner_registration_metadata=none_detected/);
  assert.match(hostAudit,/name \.runner/);
  assert.match(hostAudit,/name \.credentials/);
  assert.match(hostAudit,/name \.credentials_rsaparams/);
  assert.match(hostAudit,/plaintext_database_backup_artifacts/);
  assert.match(hostAudit,/Unencrypted database or full-backup archives were detected/);
  assert.match(hostAudit,/database_backup_cron_references/);
  assert.match(hostAudit,/plaintext draw-key backup file exists/);
  assert.doesNotMatch(hostAudit,/systemctl (?:start|stop|restart|daemon-reload)\b/i);
  assert.doesNotMatch(hostAudit,/^\s*(?:systemctl\s+(?:start|stop|restart|daemon-reload)|chmod|chown|rm|mv|ufw\s+(?:enable|allow|deny))\b/im);
  assert.ok(runbook.includes('bash scripts/production-host-preflight.sh'));
  assert.ok(runbook.includes('Settings → Actions → Runners'));
  assert.ok(runbook.includes('A non-zero exit is a release blocker'));
});

test('release runbook requires approval of exact replay-session cleanup impact',()=>{
  const runbook=readFileSync(new URL('../../docs/PRODUCTION_STAGED_DEPLOYMENT.md',import.meta.url),'utf8');
  assert.match(runbook,/reports exact row counts for six session tables whose rows are intentionally cleared/);
  assert.match(runbook,/explicitly reviewed and approved by the business owner/);
  assert.match(runbook,/Re-run the complete read-only preflight after the service is stopped/);
  assert.match(runbook,/No active release path is assumed/);
  assert.doesNotMatch(runbook,/ed490912df9eacbd15e344f4ae00a785cda09646/);
});

test('release runbook verifies append-only admin audit triggers after migration',()=>{
  const runbook=readFileSync(new URL('../../docs/PRODUCTION_STAGED_DEPLOYMENT.md',import.meta.url),'utf8');
  assert.match(runbook,/information_schema\.TRIGGERS/);
  assert.match(runbook,/trg_admin_audit_log_no_update/);
  assert.match(runbook,/trg_admin_audit_log_no_delete/);
  assert.match(runbook,/AUDIT_TRIGGER_COUNT/);
});

test('append-only audit trigger recovery verifies the protected table identity',()=>{
  const migration=readFileSync(new URL('../../src/database/migrate.js',import.meta.url),'utf8');
  assert.match(migration,/SELECT EVENT_OBJECT_TABLE,EVENT_MANIPULATION,ACTION_TIMING,ACTION_STATEMENT FROM information_schema\.TRIGGERS/);
  assert.match(migration,/row\.EVENT_OBJECT_TABLE!=='admin_audit_log'/);
});

test('append-only audit trigger recovery rejects additional trigger statements',()=>{
  const migration=readFileSync(new URL('../../src/database/migrate.js',import.meta.url),'utf8');
  assert.match(migration,/statement!==["']SIGNAL SQLSTATE/);
  assert.doesNotMatch(migration,/statement\.includes\('SQLSTATE/);
});


const postMigrationIntegrity=readFileSync(new URL('../../scripts/post-migration-integrity-check.sql',import.meta.url),'utf8');

test('post-migration integrity checks cover prepared draw encryption and keyring references',()=>{
  for(const fragment of [
    "seed_ciphertext IS NULL",
    "LENGTH(seed_nonce)<>24",
    "LENGTH(seed_tag)<>32",
    "algorithm<>'HMAC-SHA256 candidate-commitment-rank-v2'",
    "SELECT seed_key_id, COUNT(*) AS prepared_draw_count"
  ]){
    assert.ok(postMigrationIntegrity.includes(fragment),`post-migration integrity check is missing ${fragment}`);
  }
});

test('post-migration integrity checks detect campaign code counter drift and duplicate sequences',()=>{
  for(const fragment of [
    "counter.last_sequence",
    "MAX(cc.sequence_number)",
    "missing_sequence_count",
    "counter.last_sequence IS NULL AND COUNT(cc.id)>0",
    "GROUP BY campaign_id,sequence_number",
    "HAVING COUNT(*)>1"
  ]){
    assert.ok(postMigrationIntegrity.includes(fragment),`post-migration integrity check is missing ${fragment}`);
  }
});

test('post-migration integrity script is read-only and separated from baseline preflight',()=>{
  assert.doesNotMatch(postMigrationIntegrity,/^\s*(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE|DROP|TRUNCATE|CALL)\b/im);
  assert.doesNotMatch(preflight,/seed_ciphertext IS NULL|counter\.last_sequence|MAX\(cc\.sequence_number\)/);
});


test('release runbook separates baseline and post-migration integrity checks',()=>{
  const runbook=readFileSync(new URL('../../docs/PRODUCTION_STAGED_DEPLOYMENT.md',import.meta.url),'utf8');
  const readiness=readFileSync(new URL('../../docs/RELEASE_READINESS.md',import.meta.url),'utf8');
  assert.ok(runbook.includes('scripts/production-migration-preflight.sql'));
  assert.ok(runbook.includes('bash scripts/production-host-preflight.sh'));
  assert.ok(readiness.includes('scripts/production-host-preflight.sh'));
  assert.ok(readiness.includes('all six replay-cleanup tables and both retained-but-cursorless search-session tables'));
  assert.ok(runbook.includes('scripts/post-migration-integrity-check.sql'));
  assert.ok(runbook.includes('dedicated SELECT-only MySQL account'));
  assert.ok(runbook.includes('SHOW GRANTS'));
  assert.ok(readiness.includes('scripts/post-migration-integrity-check.sql'));
  assert.ok(readiness.includes('counter drift'));
  assert.ok(readiness.includes('External Production gates'));
  assert.ok(readiness.includes('full-history secret scan'));
  assert.ok(readiness.includes('automated database backups are scheduled'));
});
