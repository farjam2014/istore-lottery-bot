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
  assert.doesNotMatch(source,/!\\s*hasPermission\\s*\\(/);
});
