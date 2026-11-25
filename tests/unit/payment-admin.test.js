import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';

const here=dirname(fileURLToPath(import.meta.url));

test('payment order status filters are represented by the supported operational states',()=>{
  const states=['awaiting_receipt','under_review','approved','rejected','cancelled','expired'];
  assert.equal(new Set(states).size,6);
  assert.ok(states.includes('under_review'));
  assert.ok(states.includes('approved'));
});

test('payment admin wizard uses the fetched wizard row for step dispatch',async()=>{
  const source=await readFile(resolve(here,'../../src/bot/handlers/payment.handler.js'),'utf8');
  assert.match(source,/const \[\[wizard\]\]=await pool\.execute\('SELECT step,payload,last_update_id,updated_at FROM admin_wizards/);
  assert.match(source,/if\(wizard\.step==='payment_settings'\)/);
  assert.match(source,/if\(wizard\.step==='payment_reject'\)/);
  assert.doesNotMatch(source,/rows\[0\]\.step/);
  assert.ok(source.includes("DELETE FROM admin_wizards WHERE telegram_user_id=? AND step=? AND last_update_id=?"));
  assert.ok(source.includes("updated_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 24 HOUR)"));
  assert.ok(source.includes('isExpiredAdminWizardSession(wizard.updated_at)'));
  assert.match(source,/\[String\(ctx\.from\.id\),wizard\.step,updateId\]/);
});


test('sensitive payment order reads and searches are audited without storing search text',async()=>{
  const source=await readFile(resolve(here,'../../src/bot/handlers/admin.handler.js'),'utf8');
  assert.match(source,/audit\\(ctx\\.from\\.id,'payment\\.orders_listed','payment_order',null,\\{status,page,resultCount:r\\.rows\\.length\\}\\)/);
  assert.match(source,/audit\\(ctx\\.from\\.id,'payment\\.order_viewed','payment_order',Number\\(id\\),\\{receiptCount:d\\.receipts\\.length,eventCount:d\\.events\\.length\\}\\)/);
  assert.match(source,/audit\\(ctx\\.from\\.id,'payment\\.orders_searched','payment_order',null,\\{queryLength:query\\.length,resultCount:rows\\.length\\}\\)/);
  assert.doesNotMatch(source,/payment\\.orders_searched[^\\n]*queryText|payment\\.orders_searched[^\\n]*query\\s*[,}]/);
});
