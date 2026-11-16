import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const handlerPath=fileURLToPath(new URL('../../src/bot/handlers/admin.handler.js',import.meta.url));
const servicePath=fileURLToPath(new URL('../../src/modules/notifications/failed-retry.service.js',import.meta.url));
const [handler,service]=await Promise.all([readFile(handlerPath,'utf8'),readFile(servicePath,'utf8')]);
const promptStart=handler.indexOf("bot.action('admin:system:outbox:retry',");
const confirmStart=handler.indexOf("bot.action(/^admin:sys:fr:");
const nextAction=handler.indexOf("bot.action(",confirmStart+1);
const prompt=handler.slice(promptStart,confirmStart);
const confirmation=handler.slice(confirmStart,nextAction>confirmStart?nextAction:undefined);

test('failed notification retry previews a bounded batch and warns before any update',()=>{
  assert.ok(promptStart>=0);
  assert.ok(confirmStart>promptStart);
  assert.match(prompt,/previewFailedNotifications/);
  assert.match(prompt,/تلاش مجدد اعلان‌های ناموفق/);
  assert.match(prompt,/علت خطا را بررسی کنید/);
  assert.match(prompt,/پیام تکراری ایجاد کند/);
  assert.match(prompt,/batchCount/);
  assert.match(prompt,/batchHash/);
  assert.match(prompt,/admin:sys:fr:/);
  assert.doesNotMatch(prompt,/UPDATE telegram_notification_outbox/);
});

test('failed notification retry confirmation remains super-admin-only and calls the transactional service',()=>{
  assert.match(prompt,/isConfiguredSuperAdmin\(ctx\.from\.id\)/);
  assert.match(confirmation,/isConfiguredSuperAdmin\(ctx\.from\.id\)/);
  assert.match(confirmation,/retryFailedNotifications/);
  assert.match(confirmation,/expectedBatchHash/);
  assert.match(confirmation,/result\.confirmed/);
});

test('failed retry service limits batches, binds snapshot, serializes and audits the transaction',()=>{
  assert.match(service,/FAILED_RETRY_BATCH_LIMIT=100/);
  assert.match(service,/status='failed' AND id<=\? ORDER BY id LIMIT \? FOR UPDATE/);
  assert.match(service,/hashIds\(ids\)!==expectedHash/);
  assert.match(service,/GET_LOCK\(\?,10\)/);
  assert.match(service,/RELEASE_LOCK\(\?\)/);
  assert.match(service,/INSERT INTO admin_audit_log/);
  assert.ok(service.includes("LEFT(COALESCE(last_error,''),400)"));
  assert.match(service,/if\(transactionOpen\)\{try\{await c\.rollback\(\);\}catch\{reusable=false;\}\}/);
  assert.match(service,/if\(reusable\)c\.release\(\);else c\.destroy\(\)/);
});

test('failed retry callback token stays within Telegram 64-byte limit for 64-bit identifiers',()=>{
  const countToken=((2n**63n)-1n).toString(36);
  const maxId='18446744073709551615';
  const token='admin:sys:fr:'+countToken+':'+maxId+':'+'a'.repeat(16);
  assert.ok(Buffer.byteLength(token,'utf8')<=64);
  assert.match(token,/^admin:sys:fr:([0-9a-z]+):([0-9]+):([a-f0-9]{16})$/);
});
