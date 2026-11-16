import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const adminPath=fileURLToPath(new URL('../../src/bot/handlers/admin.handler.js',import.meta.url));
const schedulerPath=fileURLToPath(new URL('../../src/modules/campaigns/campaign-scheduler.js',import.meta.url));
const servicePath=fileURLToPath(new URL('../../src/modules/campaigns/campaign-status.service.js',import.meta.url));
const [admin,scheduler,service]=await Promise.all([readFile(adminPath,'utf8'),readFile(schedulerPath,'utf8'),readFile(servicePath,'utf8')]);

test('campaign detail exposes explicit pause and activate actions rather than a replayable toggle',()=>{
  assert.match(admin,/admin:campaign:pause:/);
  assert.match(admin,/admin:campaign:activate:/);
  assert.ok(admin.includes("if(['open','scheduled'].includes(c.status))actions.push"));
  assert.match(admin,/این دکمه قدیمی است/);
  const legacyStart=admin.indexOf("bot.action(/^admin:campaign:toggle:");
  const legacyEnd=admin.indexOf("bot.action(",legacyStart+10);
  const legacy=admin.slice(legacyStart,legacyEnd);
  assert.doesNotMatch(legacy,/UPDATE campaigns/);
  assert.doesNotMatch(legacy,/setCampaignStatus/);
});

test('campaign status changes lock the campaign row and audit within the same transaction',()=>{
  assert.match(service,/SELECT id,status,starts_at,ends_at.*FROM campaigns WHERE id=\? FOR UPDATE/);
  assert.match(service,/INSERT INTO admin_audit_log/);
  assert.match(service,/await c\.commit\(\)/);
  assert.match(service,/await c\.rollback\(\)/);
});

test('scheduler closes expired paused campaigns as well as expired open campaigns',()=>{
  assert.match(scheduler,/status IN \('open','paused'\) AND ends_at IS NOT NULL/);
  assert.match(scheduler,/campaign\.status==='scheduled'.*?'open':'closed'/);
});
