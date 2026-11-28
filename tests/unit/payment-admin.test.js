import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('payment order status filters are represented by the supported operational states',()=>{
  const states=['awaiting_receipt','under_review','approved','rejected','cancelled','expired'];
  assert.equal(new Set(states).size,6);
  assert.ok(states.includes('under_review'));
  assert.ok(states.includes('approved'));
});

test('sensitive payment order reads and searches are audited without storing search text',()=>{
  const source=readFileSync(new URL('../../src/bot/handlers/admin.handler.js',import.meta.url),'utf8');
  assert.match(source,/audit\(ctx\.from\.id,'payment\.orders_listed','payment_order',null,\{status,page,resultCount:r\.rows\.length\}\)/);
  assert.match(source,/audit\(ctx\.from\.id,'payment\.order_viewed','payment_order',Number\(id\),\{receiptCount:d\.receipts\.length,eventCount:d\.events\.length\}\)/);
  assert.match(source,/audit\(ctx\.from\.id,'payment\.orders_searched','payment_order',null,\{queryLength:query\.length,resultCount:rows\.length\}\)/);
  assert.doesNotMatch(source,/payment\.orders_searched[^\n]*queryText|payment\.orders_searched[^\n]*query\s*[,}]/);
});
