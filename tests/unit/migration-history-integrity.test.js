import test from 'node:test';
import assert from 'node:assert/strict';
import {assertMigrationHistoryIntegrity} from '../../src/database/migration-integrity.js';

test('migration history is valid when every applied migration exists in source',()=>{
  assert.equal(assertMigrationHistoryIntegrity(
    ['20261117_001_a.sql','20261119_002_b.sql'],
    ['20261117_001_a.sql','20261119_002_b.sql','20261120_003_c.sql']
  ),true);
});

test('migration history fails closed when an applied migration file is missing',()=>{
  assert.throws(
    ()=>assertMigrationHistoryIntegrity(
      ['20261119_001_campaign_edit_wizard_step.sql','20261119_002_telegram_update_inbox.sql'],
      ['20261119_002_telegram_update_inbox.sql']
    ),
    /Applied migrations are missing from source: 20261119_001_campaign_edit_wizard_step\.sql/
  );
});

test('duplicate applied versions are reported once and sorted',()=>{
  assert.throws(
    ()=>assertMigrationHistoryIntegrity(['z.sql','a.sql','z.sql'],[]),
    /Applied migrations are missing from source: a\.sql, z\.sql/
  );
});
