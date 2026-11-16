import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const handlerPath=fileURLToPath(new URL('../../src/bot/handlers/admin.handler.js',import.meta.url));
const servicePath=fileURLToPath(new URL('../../src/modules/notifications/uncertain-retry.service.js',import.meta.url));
const [handler,service]=await Promise.all([readFile(handlerPath,'utf8'),readFile(servicePath,'utf8')]);
const promptStart=handler.indexOf("bot.action('admin:system:outbox:retry-uncertain',");
const confirmStart=handler.indexOf("bot.action(/^admin:sys:ur:");
const nextAction=handler.indexOf("bot.action(",confirmStart+1);
const prompt=handler.slice(promptStart,confirmStart);
const confirmation=handler.slice(confirmStart,nextAction>confirmStart?nextAction:undefined);

test('uncertain retry preview warns first and binds a bounded snapshot to callback data',()=>{
  assert.ok(promptStart>=0);
  assert.ok(confirmStart>promptStart);
  assert.match(prompt,/previewUncertainNotifications/);
  assert.match(prompt,/هشدار/);
  assert.match(prompt,/batchCount/);
  assert.match(prompt,/batchHash/);
  assert.match(prompt,/admin:sys:ur:/);
  assert.doesNotMatch(prompt,/UPDATE telegram_notification_outbox/);
});

test('confirmation remains super-admin-only and calls the transactional retry service',()=>{
  assert.match(prompt,/isConfiguredSuperAdmin\(ctx\.from\.id\)/);
  assert.match(confirmation,/isConfiguredSuperAdmin\(ctx\.from\.id\)/);
  assert.match(confirmation,/retryUncertainNotifications/);
  assert.match(confirmation,/expectedBatchHash/);
  assert.match(confirmation,/result\.confirmed/);
});

test('retry service locks at most 100 previewed IDs, checks the snapshot hash and audits the operator',()=>{
  assert.match(service,/UNCERTAIN_RETRY_BATCH_LIMIT=100/);
  assert.match(service,/id<=\? ORDER BY id LIMIT \? FOR UPDATE/);
  assert.match(service,/hashIds\(ids\)!==expectedHash/);
  assert.match(service,/INSERT INTO admin_audit_log/);
  assert.match(service,/manual retry by/);
});

test('snapshot callback token stays within Telegram 64-byte callback limit for 64-bit identifiers',()=>{
  const countToken=((2n**63n)-1n).toString(36);
  const maxId='18446744073709551615';
  const token='admin:sys:ur:'+countToken+':'+maxId+':'+'a'.repeat(16);
  assert.ok(Buffer.byteLength(token,'utf8')<=64);
  assert.match(token,/^admin:sys:ur:([0-9a-z]+):(\\d+):([a-f0-9]{16})$/);
});
