import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const policy=readFileSync(fileURLToPath(new URL('../../docs/PRIVACY_AND_RETENTION.md',import.meta.url)),'utf8');
const retentionWorker=readFileSync(fileURLToPath(new URL('../../src/modules/privacy/retention-cleanup.worker.js',import.meta.url)),'utf8');
const updateGuard=readFileSync(fileURLToPath(new URL('../../src/bot/middleware/update-guard.js',import.meta.url)),'utf8');
const retentionWorker=readFileSync(fileURLToPath(new URL('../../src/modules/privacy/retention-cleanup.worker.js',import.meta.url)),'utf8');

test('privacy policy does not claim inbox payload deletion that the worker does not implement',()=>{
  assert.match(policy,/No payload TTL\/deletion is implemented by the current retention worker/);
  assert.match(policy,/worker is disabled by default/);
  assert.doesNotMatch(retentionWorker,/DELETE FROM telegram_update_inbox/i);
  assert.match(retentionWorker,/UPDATE telegram_update_inbox SET last_error=/);
});

test('privacy policy matches actual inbox cleanup paths and does not invent a failed-row TTL',()=>{
  assert.match(policy,/retention cleanup worker does not delete inbox payloads/);
  assert.match(policy,/deletes `completed` inbox rows older than 3 days/);
  assert.match(policy,/There is no deletion TTL for `pending`, `failed`, or stale `processing` inbox rows/);
  assert.doesNotMatch(retentionWorker,/DELETE FROM telegram_update_inbox/i);
  assert.match(retentionWorker,/UPDATE telegram_update_inbox SET last_error=/);
  assert.match(updateGuard,/DELETE FROM telegram_update_inbox WHERE status='completed' AND completed_at<UTC_TIMESTAMP\(\)-INTERVAL 3 DAY/);
  assert.match(updateGuard,/count%500===0/);
});

test('privacy inventory explicitly covers event and audit tables without inventing retention periods',()=>{
  for(const table of ['admin_audit_log','payment_events','admin_role_events','admin_action_idempotency','telegram_notification_outbox']){
    assert.ok(policy.includes('`'+table+'`'),`missing retention inventory for ${table}`);
  }
  assert.match(policy,/There is no retention\/archival worker or approved retention period/);
  assert.match(policy,/There is no cleanup or archival path and no approved retention period/);
  assert.match(policy,/append-only triggers mean a future retention process needs an explicitly reviewed archive-and-purge design/);
});
