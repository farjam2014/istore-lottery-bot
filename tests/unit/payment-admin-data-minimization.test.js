import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const source=readFileSync(fileURLToPath(new URL('../../src/modules/payments/payment-admin.service.js',import.meta.url)),'utf8');
const selectStatements=[...source.matchAll(/"SELECT ([^"]+)"/g)].map(match=>match[1]);

test('finance order list and search do not select participant contact identifiers',()=>{
  const list=selectStatements.find(sql=>sql.includes('receipt_count'));
  const search=selectStatements.find(sql=>sql.includes('WHERE o.payment_reference='));
  assert.ok(list);
  assert.ok(search);
  for(const sql of [list,search]){
    assert.doesNotMatch(sql,/p\.(?:telegram_user_id|phone|instagram_handle|telegram_username)/);
  }
});

test('finance order detail exposes only the participant phone needed for payment follow-up',()=>{
  const detail=selectStatements.find(sql=>sql.includes('o.bank_name'));
  assert.ok(detail);
  assert.match(detail,/p\.full_name,p\.phone/);
  assert.doesNotMatch(detail,/p\.(?:telegram_user_id|instagram_handle|telegram_username)/);
});

test('payment CSV export contains order and campaign fields only',()=>{
  const exported=selectStatements.find(sql=>sql.includes('o.approved_at')&&sql.includes('campaign_title'));
  assert.ok(exported);
  assert.doesNotMatch(exported,/participants|p\./);
});
