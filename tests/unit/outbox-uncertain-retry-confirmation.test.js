import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const handlerPath=fileURLToPath(new URL('../../src/bot/handlers/admin.handler.js',import.meta.url));
const source=await readFile(handlerPath,'utf8');
const promptStart=source.indexOf("bot.action('admin:system:outbox:retry-uncertain',");
const confirmStart=source.indexOf('bot.action(/^admin:sys:ur:');
const nextAction=source.indexOf("bot.action('admin:profile-requests'",confirmStart+1);
const prompt=source.slice(promptStart,confirmStart);
const confirmation=source.slice(confirmStart,nextAction>confirmStart?nextAction:undefined);

test('uncertain notification retry previews duplicate risk and queue snapshot before any mutation',()=>{
  assert.ok(promptStart>=0);
  assert.ok(confirmStart>promptStart);
  assert.match(prompt,/COUNT\(\*\)/);
  assert.match(prompt,/MAX\(id\)/);
  assert.match(prompt,/ممکن است تلگرام/);
  assert.match(prompt,/تأیید ارسال مجدد/);
  assert.match(prompt,/admin:sys:ur:/);
  assert.doesNotMatch(prompt,/UPDATE telegram_notification_outbox/);
});

test('uncertain retry confirmation remains super-admin-only and delegates to the transactional service',()=>{
  assert.match(prompt,/isConfiguredSuperAdmin\(ctx\.from\.id\)/);
  assert.match(confirmation,/isConfiguredSuperAdmin\(ctx\.from\.id\)/);
  assert.match(confirmation,/retryUncertainNotifications/);
  assert.match(confirmation,/expectedCount/);
  assert.match(confirmation,/expectedMaxId/);
  assert.doesNotMatch(confirmation,/UPDATE telegram_notification_outbox/);
});
