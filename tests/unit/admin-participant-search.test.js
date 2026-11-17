import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('admin participant search callback starts a search session and supports cancellation', async () => {
  const source = await readFile(new URL('../../src/bot/handlers/admin.handler.js', import.meta.url), 'utf8');

  assert.match(source, /bot\.action\('admin:participants:search',async ctx=>\{/);
  assert.match(source, /INSERT INTO admin_search_sessions\(telegram_user_id,step,campaign_id\) VALUES\(\?,'participant',NULL\) ON DUPLICATE KEY UPDATE step='participant',campaign_id=NULL/);
  assert.match(source, /عبارت جست‌وجو را ارسال کنید/);
  assert.match(source, /bot\.action\('admin:participants:search:cancel',async ctx=>\{/);
  assert.match(source, /DELETE FROM admin_search_sessions WHERE telegram_user_id=\? AND step='participant'/);
  assert.match(source, /if\(participantSearch\).*showParticipants\(ctx,0,query\)/s);
  assert.match(source, /مشتری‌ای پیدا نشد/);
});
