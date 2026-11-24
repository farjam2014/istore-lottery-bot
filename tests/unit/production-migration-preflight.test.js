import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const preflight=readFileSync(new URL('../../scripts/production-migration-preflight.sql',import.meta.url),'utf8');

const expectedReleaseMigrations=[
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
  '20261124_004_admin_wizard_replay.sql'
];

test('production migration preflight enumerates every release migration after the baseline',()=>{
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
    "table_name='admin_action_idempotency' AND column_name IN ('idempotency_key','action_type','actor_telegram_id','entity_id','created_at')"
  ]){
    assert.ok(preflight.includes(fragment),`preflight is missing schema capability check: ${fragment}`);
  }
});
