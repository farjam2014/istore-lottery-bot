import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('admin participant search callback starts a search session, persists results and supports cancellation', async () => {
  const source = await readFile(new URL('../../src/bot/handlers/admin.handler.js', import.meta.url), 'utf8');

  assert.ok(source.includes("bot.action('admin:participants:search',async ctx=>{"));
  assert.match(source, /INSERT INTO admin_search_sessions\(telegram_user_id,step,campaign_id,query_text,last_update_id\) VALUES\(\?,'participant',NULL,NULL,\?\)/);
  assert.match(source, /step=IF\(VALUES\(last_update_id\)>COALESCE\(last_update_id,-1\),'participant',step\)/);
  assert.match(source, /last_update_id=GREATEST\(COALESCE\(last_update_id,-1\),VALUES\(last_update_id\)\)/);
  assert.ok(source.includes('عبارت جست‌وجو را ارسال کنید'));
  assert.ok(source.includes("bot.action(/^admin:participants:search:cancel:(\\d{1,16})$/,async ctx=>{"));
  assert.ok(source.includes("step IN ('participant','participant_results') AND last_update_id=?"));
  assert.ok(source.includes("SET step='participant_results',campaign_id=NULL,query_text=?"));
  assert.ok(source.includes("SELECT query_text FROM admin_search_sessions WHERE telegram_user_id=? AND step='participant_results'"));
  assert.ok(source.includes("hasPermission(ctx.from.id,'participant.export')"));
  assert.ok(source.includes("'admin:participant:view:'+p.id+':'+pagination.page"));
  assert.ok(source.includes("admin:participant:view:(\\d+)(?::(\\d+))?"));
  assert.ok(source.includes("admin:participants:page:'+(Number(ctx.match[2])||0)"));
  assert.match(source, /if\(participantSearch\).*showParticipants\(ctx,0,query\)/s);
  assert.ok(source.includes('مشتری‌ای پیدا نشد'));
});
