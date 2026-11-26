import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const service=readFileSync(fileURLToPath(new URL('../../src/modules/payments/payment.service.js',import.meta.url)),'utf8');
const admin=readFileSync(fileURLToPath(new URL('../../src/bot/handlers/admin.handler.js',import.meta.url)),'utf8');

test('payment decision event and admin audit details do not duplicate free-text rejection reasons',()=>{
  const start=service.indexOf('export async function reviewReceipt');
  const end=service.indexOf('export async function expirePendingOrders',start);
  const review=service.slice(start,end);
  assert.ok(start>=0);
  assert.doesNotMatch(review,/JSON\.stringify\(\{receiptId,reason\}\)/);
  assert.match(review,/JSON\.stringify\(\{receiptId\}\)/);
});

test('finance order history does not display actor Telegram IDs or raw event payloads',()=>{
  const start=admin.indexOf('async function showManagedOrderDetail');
  const end=admin.indexOf('\n}',start);
  const view=admin.slice(start,end);
  assert.ok(start>=0);
  assert.match(view,/d\.events\.map\(x=>x\.event_type\+' \| '\+formatTehranDateTime\(x\.created_at\)\)/);
  assert.doesNotMatch(view,/x\.actor_telegram_id|x\.details|JSON\.stringify\(x\.details\)/);
});
