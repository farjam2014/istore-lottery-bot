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
  assert.match(handler,/bot\.action\(paymentApproveAction,async ctx=>\{if\(!await can\(ctx,'payment\.review'\)\)/);
  assert.match(handler,/bot\.action\(paymentRejectAction,async ctx=>\{if\(!await can\(ctx,'payment\.review'\)\)/);
});
