import test from 'node:test';
import assert from 'node:assert/strict';
import {shouldBypassRegistration} from '../../src/bot/middleware/registration-admin.js';

test('configured super-admins bypass registration without a database permission lookup',async()=>{
  let lookups=0;
  const result=await shouldBypassRegistration({
    telegramId:123,
    configuredAdminIds:new Set(['123']),
    hasDashboardPermission:async()=>{lookups++;return false;}
  });
  assert.equal(result,true);
  assert.equal(lookups,0);
});

test('active staff with dashboard permission bypass pending customer registration',async()=>{
  const result=await shouldBypassRegistration({
    telegramId:456,
    configuredAdminIds:new Set(['123']),
    hasDashboardPermission:async id=>id==='456'
  });
  assert.equal(result,true);
});

test('inactive staff and ordinary users do not bypass registration',async()=>{
  const inactive=await shouldBypassRegistration({
    telegramId:456,
    configuredAdminIds:new Set(['123']),
    hasDashboardPermission:async()=>false
  });
  const ordinary=await shouldBypassRegistration({
    telegramId:789,
    configuredAdminIds:new Set(['123']),
    hasDashboardPermission:async()=>false
  });
  assert.equal(inactive,false);
  assert.equal(ordinary,false);
});

test('missing Telegram identity never bypasses registration',async()=>{
  let lookups=0;
  const result=await shouldBypassRegistration({
    telegramId:null,
    configuredAdminIds:new Set(),
    hasDashboardPermission:async()=>{lookups++;return true;}
  });
  assert.equal(result,false);
  assert.equal(lookups,0);
});

test('contact and text registration handlers both pass active staff updates through',async()=>{
  const {readFile}=await import('node:fs/promises');
  const {fileURLToPath}=await import('node:url');
  const path=await import('node:path');
  const handlerPath=fileURLToPath(new URL('../../src/bot/handlers/registration.handler.js',import.meta.url));
  const source=await readFile(path.resolve(handlerPath),'utf8');
  const bypassCalls=source.match(/if\\(await bypassRegistration\\(ctx\\)\\)return next\\(\\);/g)||[];
  assert.equal(bypassCalls.length,2);
});
