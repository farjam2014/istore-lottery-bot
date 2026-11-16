import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const userPath=fileURLToPath(new URL('../../src/bot/handlers/user.handler.js',import.meta.url));
const paymentPath=fileURLToPath(new URL('../../src/bot/handlers/payment.handler.js',import.meta.url));
const [user,payment]=await Promise.all([readFile(userPath,'utf8'),readFile(paymentPath,'utf8')]);

test('customer profile and support text/contact handlers do not consume active-admin updates',()=>{
  assert.match(user,/bot\.on\('contact',async\(ctx,next\)=>\{if\(!ctx\.state\.profile\)return next\(\);if\(await bypassCustomerFlow\(ctx\)\)return next\(\);/);
  assert.match(user,/bot\.on\('text',async\(ctx,next\)=>\{if\(!ctx\.state\.profile\)return next\(\);if\(await bypassCustomerFlow\(ctx\)\)return next\(\);/);
});

test('payment customer actions and receipt-photo handler pass active admins to later handlers',()=>{
  for(const route of [
    "bot.action(/^payment:start:",
    "bot.action('payment:cancel'",
    "bot.action(/^payment:resume:",
    "bot.on('photo'",
    "bot.action('user:orders'"
  ]){
    const start=payment.indexOf(route);
    assert.ok(start>=0,route+' must be registered');
    const prefix=payment.slice(start,start+260);
    assert.match(prefix,/if\(await bypassCustomerFlow\(ctx\)\)return next\(\);/);
  }
});

test('admin payment commands and receipt-review callbacks retain their permission checks',()=>{
  assert.match(payment,/bot\.command\('payment_settings',async ctx=>\{if\(!await can\(ctx,'payment\.settings'\)\)/);
  assert.match(payment,/bot\.action\(paymentApproveAction,async ctx=>\{if\(!await can\(ctx,'payment\.review'\)\)/);
  assert.match(payment,/bot\.action\(paymentRejectAction,async ctx=>\{if\(!await can\(ctx,'payment\.review'\)\)/);
});
