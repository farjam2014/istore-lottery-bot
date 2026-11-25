import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isOlderAdminWizardReplay,isExpiredAdminWizardSession,isStaleAdminReplyUpdate} from '../../src/modules/admin/admin-wizard-replay.js';

test('admin wizard rejects a replayed update already applied to the current step',()=>{
  const wizard={step:'title',lastUpdateId:101};
  assert.equal(isOlderAdminWizardReplay({state:{durableReplay:true},update:{update_id:101}},wizard),true);
  assert.equal(isOlderAdminWizardReplay({state:{durableReplay:true},update:{update_id:100}},wizard),true);
});

test('admin wizard allows a newer update and all first-attempt updates',()=>{
  const wizard={step:'description',lastUpdateId:101};
  assert.equal(isOlderAdminWizardReplay({state:{durableReplay:true},update:{update_id:102}},wizard),false);
  assert.equal(isOlderAdminWizardReplay({state:{durableReplay:false},update:{update_id:100}},wizard),false);
});

test('admin wizard does not reject when there is no persisted cursor',()=>{
  assert.equal(isOlderAdminWizardReplay({state:{durableReplay:true},update:{update_id:100}},{step:'title',lastUpdateId:null}),false);
});

test('admin wizard session expires at the configured TTL boundary',()=>{
  const now=Date.parse('2026-11-25T12:00:00Z');
  assert.equal(isExpiredAdminWizardSession('2026-11-24T12:00:00Z',now),true);
  assert.equal(isExpiredAdminWizardSession('2026-11-24T12:00:01Z',now),false);
});

test('admin wizard session expiry fails closed for invalid timestamps',()=>{
  assert.equal(isExpiredAdminWizardSession('not-a-date',Date.now()),true);
});

test('admin support reply sessions expire after 24 hours before consuming text',()=>{
  const source=readFileSync(new URL('../../src/bot/handlers/admin.handler.js',import.meta.url),'utf8');
  assert.match(source,/support_sessions WHERE telegram_user_id=\? AND updated_at>=DATE_SUB\(UTC_TIMESTAMP\(\),INTERVAL 24 HOUR\)/);
  assert.match(source,/support_sessions WHERE telegram_user_id=\? AND step='admin_reply'[^\n]*updated_at/);
  assert.match(source,/isExpiredAdminWizardSession\(lockedSession\.updated_at\)/);
  assert.match(source,/ticket_id=VALUES\(ticket_id\),category=NULL,updated_at=CURRENT_TIMESTAMP/);
});

test('admin search sessions enforce a 24-hour TTL and refresh it when restarted',()=>{
  const source=readFileSync(new URL('../../src/bot/handlers/admin.handler.js',import.meta.url),'utf8');
  assert.match(source,/admin_search_sessions WHERE telegram_user_id=\? AND step='participant' AND created_at>=DATE_SUB\(UTC_TIMESTAMP\(\),INTERVAL 24 HOUR\)/);
  assert.match(source,/admin_search_sessions WHERE telegram_user_id=\? AND step='campaign_code' AND created_at>=DATE_SUB\(UTC_TIMESTAMP\(\),INTERVAL 24 HOUR\)/);
  assert.match(source,/payment_admin_sessions WHERE telegram_user_id=\? AND step='search_order' AND created_at>=DATE_SUB\(UTC_TIMESTAMP\(\),INTERVAL 24 HOUR\)/);
  assert.match(source,/campaign_id=VALUES\(campaign_id\),created_at=CURRENT_TIMESTAMP/);
  assert.match(source,/query_text=NULL,created_at=CURRENT_TIMESTAMP/);
  assert.match(source,/status_filter='all',created_at=CURRENT_TIMESTAMP/);
});

test('admin wizard handler applies expiry to every text-consuming wizard step',()=>{
  const source=readFileSync(new URL('../../src/bot/handlers/admin.handler.js',import.meta.url),'utf8');
  assert.match(source,/if\(isExpiredAdminWizardSession\(r\[0\]\.updated_at\)\)/);
  assert.doesNotMatch(source,/\['payment_settings','payment_reject'\]\.includes\(r\[0\]\.step\)/);
});

test('callback transactions recheck admin wizard expiry while holding the row lock',()=>{
  const handler=readFileSync(new URL('../../src/bot/handlers/admin.handler.js',import.meta.url),'utf8');
  assert.match(handler,/SELECT step,payload,updated_at FROM admin_wizards WHERE telegram_user_id=\? FOR UPDATE/);
  assert.match(handler,/lockedWizard\.step!=='draw_publication_confirm'\|\|isExpiredAdminWizardSession\(lockedWizard\.updated_at\)/);
  assert.match(handler,/lockedWizard\.step!=='campaign_edit_value'\|\|isExpiredAdminWizardSession\(lockedWizard\.updated_at\)/);
});

test('admin support reply rejects updates at or before the session-start cursor',()=>{
  assert.equal(isStaleAdminReplyUpdate(102,101),false);
  assert.equal(isStaleAdminReplyUpdate(101,101),true);
  assert.equal(isStaleAdminReplyUpdate(100,101),true);
  assert.equal(isStaleAdminReplyUpdate(102,null),true);
});
