import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const source=readFileSync(fileURLToPath(new URL('../../src/modules/payments/payment-admin.service.js',import.meta.url)),'utf8');
const selectStatements=[...source.matchAll(/"SELECT ([^"]+)"/g)].map(match=>match[1]);
const projection=sql=>sql.split(/\s+FROM\s+/i)[0];

test('finance order list and search do not select participant contact identifiers',()=>{
  const list=selectStatements.find(sql=>sql.includes('receipt_count'));
  const search=selectStatements.find(sql=>sql.includes('WHERE o.payment_reference='));
  assert.ok(list);
  assert.ok(search);
  for(const sql of [list,search]){
    assert.doesNotMatch(projection(sql),/p\.(?:telegram_user_id|phone|instagram_handle|telegram_username)/);
  }
});

test('finance order detail exposes only the participant phone needed for payment follow-up',()=>{
  const detail=selectStatements.find(sql=>sql.includes('o.bank_name'));
  assert.ok(detail);
  assert.match(detail,/p\.full_name,p\.phone/);
  assert.doesNotMatch(detail,/p\.(?:telegram_user_id|instagram_handle|telegram_username)/);
});

test('payment CSV export contains order and campaign fields only',()=>{
  const start=source.indexOf('export async function exportManagedOrders');
  assert.ok(start>=0);
  const exportSource=source.slice(start);
  const exported=[...exportSource.matchAll(/"SELECT ([^"]+)"/g)].map(match=>match[1])[0];
  assert.ok(exported);
  assert.doesNotMatch(projection(exported),/p\.(?:telegram_user_id|phone|instagram_handle|telegram_username|full_name)/);
});
