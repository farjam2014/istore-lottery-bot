import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const sourcePath=fileURLToPath(new URL('../../src/bot/handlers/admin.handler.js',import.meta.url));
const source=readFileSync(sourcePath,'utf8');

test('admin home evaluates both asynchronous alternative permissions',()=>{
  assert.ok(source.includes("if(data==='admin:home')return (await hasPermission(id,'dashboard.read'))||(await hasPermission(id,'campaign.read'));"));
});

test('campaign-code text sessions require both permissions after awaiting them',()=>{
  assert.ok(source.includes("if(searchSession?.step==='campaign_code')return (await hasPermission(id,'campaign.read'))&&(await hasPermission(id,'participant.read'));"));
});

test('campaign-code search denies callers missing either permission',()=>{
  assert.ok(source.includes("if(!(await hasPermission(ctx.from.id,'campaign.read'))||!(await hasPermission(ctx.from.id,'participant.read')))return deny(ctx);"));
});

test('campaign-code export denies callers missing either permission',()=>{
  assert.ok(source.includes("if(!(await hasPermission(ctx.from.id,'campaign.read'))||!(await hasPermission(ctx.from.id,'participant.export')))return deny(ctx);"));
});

test('admin handler contains no negated un-awaited permission promise',()=>{
  assert.doesNotMatch(source,/!\s*hasPermission\s*\(/);
});

test('campaign managers can search campaign codes but cannot search by contact identifiers',()=>{
  assert.ok(source.includes("const contactLookup=isConfiguredSuperAdmin(ctx.from.id);"));
  assert.ok(source.includes("WHERE cc.campaign_id=? AND cc.code LIKE ? ESCAPE '!'"));
  assert.doesNotMatch(source,/WHERE cc\.campaign_id=\? AND \(cc\.code LIKE \? ESCAPE '!' OR CAST\(p\.telegram_user_id AS CHAR\)=\? OR p\.phone LIKE \? ESCAPE '!'/);
});

test('campaign-code search exposes contact details only in the configured super-admin branch',()=>{
  assert.match(source,/const message=contactLookup\s*\?rows\.map\(x=>x\.code.*x\.phone.*x\.telegram_user_id/);
  assert.match(source,/:rows\.map\(x=>x\.code.*x\.code_status.*x\.entry_status/);
});
