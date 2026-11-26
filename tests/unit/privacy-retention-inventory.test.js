import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const policy=readFileSync(fileURLToPath(new URL('../../docs/PRIVACY_AND_RETENTION.md',import.meta.url)),'utf8');

test('privacy inventory explicitly covers event and audit tables without inventing retention periods',()=>{
  for(const table of ['admin_audit_log','payment_events','admin_role_events','admin_action_idempotency','telegram_notification_outbox']){
    assert.ok(policy.includes('`'+table+'`'),`missing retention inventory for ${table}`);
  }
  assert.match(policy,/There is no retention\/archival worker or approved retention period/);
  assert.match(policy,/There is no cleanup or archival path and no approved retention period/);
  assert.match(policy,/append-only triggers mean a future retention process needs an explicitly reviewed archive-and-purge design/);
});
