import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const service=readFileSync(fileURLToPath(new URL('../../src/modules/payments/payment.service.js',import.meta.url)),'utf8');
const handler=readFileSync(fileURLToPath(new URL('../../src/bot/handlers/payment.handler.js',import.meta.url)),'utf8');

test('pending receipt review data excludes Instagram handles',()=>{
  const start=service.indexOf('export async function listPendingReceipts');
  const end=service.indexOf('\n',start);
  const query=service.slice(start,end);
  assert.ok(start>=0,'pending receipt query must exist');
  assert.doesNotMatch(query,/p\.instagram_handle|instagram_handle/);
});

test('receipt review notification does not disclose Instagram handles',()=>{
  const start=service.indexOf('export async function submitReceipt');
  const end=service.indexOf('export async function listPendingReceipts',start);
  const submit=service.slice(start,end);
  assert.ok(start>=0);
  assert.doesNotMatch(submit,/o\.instagram_handle|اینستاگرام:/);
});

test('receipt queue is readable with payment.read while decisions require payment.review',()=>{
  assert.match(handler,/bot\.command\('payments',async ctx=>\{if\(!await can\(ctx,'payment\.read'\)\)/);
  const queueLine=handler.split('\n').find(line=>line.includes("bot.command('payments'"));
  assert.ok(queueLine);
  assert.doesNotMatch(queueLine,/instagram_handle|اینستاگرام/);
  assert.match(handler,/bot\.action\(paymentApproveAction,async ctx=>\{if\(!await can\(ctx,'payment\.review'\)\)/);
  assert.match(handler,/bot\.action\(paymentRejectAction,async ctx=>\{if\(!await can\(ctx,'payment\.review'\)\)/);
});


test('receipt upload does not advance its replay cursor before the receipt transaction commits',()=>{
  const start=handler.indexOf("bot.on('photo'");
  const end=handler.indexOf("bot.action('user:orders'",start);
  const photo=handler.slice(start,end);
  assert.ok(start>=0&&end>start);
  assert.doesNotMatch(photo,/UPDATE telegram_user_sessions SET last_update_id/);
  assert.match(photo,/sessionCursor:\{expectedLastUpdateId:session\.last_update_id,updateId\}/);
  assert.match(photo,/if\(isRetryablePaymentReceiptError\(e\)\)throw e/);
});

test('receipt persistence consumes the upload session in the same transaction',()=>{
  const start=service.indexOf('export async function submitReceipt');
  const end=service.indexOf('export async function listPendingReceipts',start);
  const submit=service.slice(start,end);
  assert.ok(start>=0&&end>start);
  assert.match(submit,/SELECT step,payload,last_update_id FROM telegram_user_sessions WHERE telegram_user_id=\? FOR UPDATE/);
  assert.match(submit,/DELETE FROM telegram_user_sessions WHERE telegram_user_id=\?.*last_update_id=\?/);
  assert.ok(submit.indexOf('DELETE FROM telegram_user_sessions')<submit.indexOf('await c.commit()'));
  assert.match(submit,/catch\(e\)\{try\{await c\.rollback\(\)\}catch\{\}/);
  assert.match(service,/export function isRetryablePaymentReceiptError/);
});
