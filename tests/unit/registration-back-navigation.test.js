import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const handlerPath=fileURLToPath(new URL('../../src/bot/handlers/registration.handler.js',import.meta.url));
const keyboardPath=fileURLToPath(new URL('../../src/bot/keyboards/user.keyboard.js',import.meta.url));
const [handler,keyboard]=await Promise.all([readFile(handlerPath,'utf8'),readFile(keyboardPath,'utf8')]);

test('phone step offers a back-to-name action without replacing Telegram contact sharing',()=>{
  assert.match(keyboard,/Markup\.button\.contactRequest\('📱 اشتراک‌گذاری شماره موبایل'\)/);
  assert.match(keyboard,/⬅️ بازگشت به نام/);
  assert.match(handler,/value==='⬅️ بازگشت به نام'/);
  assert.match(handler,/saveSession\(ctx\.from\.id,'awaiting_name',data\)/);
});

test('Instagram step offers a callback to re-verify the phone number',()=>{
  assert.match(keyboard,/registration:back:phone/);
  assert.match(handler,/bot\.action\('registration:back:phone'/);
  assert.match(handler,/saveSession\(ctx\.from\.id,'awaiting_phone',\{fullName:s\.payload\?\.fullName\}\)/);
});

test('going back to phone clears stale phone and Instagram values and returns to the contact keyboard',()=>{
  const start=handler.indexOf("bot.action('registration:back:phone'");
  const end=handler.indexOf("bot.action('registration:cancel'",start);
  const backHandler=handler.slice(start,end);
  assert.ok(start>=0&&end>start);
  assert.match(backHandler,/phoneShareKeyboard\(\)/);
  assert.match(backHandler,/cancelKeyboard\(\)/);
  assert.doesNotMatch(backHandler,/s\.payload\s*\|\|\s*\{\}/);
});

test('registration callbacks and cancel command pass active admins to later handlers',()=>{
  for(const route of [
    "bot.action('registration:start',async(ctx,next)=>{",
    "bot.action('registration:back:phone',async(ctx,next)=>{",
    "bot.action('registration:cancel',async(ctx,next)=>{",
    "bot.command('cancel',async(ctx,next)=>{"
  ]){
    const start=handler.indexOf(route);
    assert.ok(start>=0,route+' must be registered');
    const prefix=handler.slice(start,start+180);
    assert.match(prefix,/if\(await bypassRegistration\(ctx\)\)return next\(\);/);
  }
});
