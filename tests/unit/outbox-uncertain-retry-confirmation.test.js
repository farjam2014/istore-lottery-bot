import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const handlerPath=fileURLToPath(new URL('../../src/bot/handlers/admin.handler.js',import.meta.url));
const source=await readFile(handlerPath,'utf8');
const promptStart=source.indexOf("bot.action('admin:system:outbox:retry-uncertain',");
const confirmStart=source.indexOf("bot.action('admin:system:outbox:retry-uncertain:confirm',");
const nextAction=source.indexOf("bot.action(",confirmStart+1);
const prompt=source.slice(promptStart,confirmStart);
const confirmation=source.slice(confirmStart,nextAction>confirmStart?nextAction:undefined);

test('uncertain notification retry shows duplicate-delivery warning and confirmation before any update',()=>{
  assert.ok(promptStart>=0);
  assert.ok(confirmStart>promptStart);
  assert.match(prompt,/SELECT COUNT\(\*\)|SELECT COUNT\(\)/);
  assert.match(prompt,/هشدار مهم/);
  assert.match(prompt,/تأیید ارسال مجدد/);
  assert.match(prompt,/admin:system:outbox:retry-uncertain:confirm/);
  assert.doesNotMatch(prompt,/UPDATE telegram_notification_outbox/);
});

test('uncertain retry confirmation remains super-admin-only and records an audit event',()=>{
  assert.match(prompt,/isConfiguredSuperAdmin\(ctx\.from\.id\)/);
  assert.match(confirmation,/isConfiguredSuperAdmin\(ctx\.from\.id\)/);
  assert.match(confirmation,/UPDATE telegram_notification_outbox/);
  assert.match(confirmation,/system\.outbox_retry_uncertain/);
  assert.match(confirmation,/manual retry by/);
});
