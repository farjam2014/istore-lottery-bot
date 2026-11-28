import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isOlderRegistrationReplay,isRegistrationSessionCancellable,registrationSessionCursorMatches} from '../../src/bot/handlers/registration.handler.js';

test('registration rejects older updates even on their first inbox delivery',()=>{
  assert.equal(isOlderRegistrationReplay({update:{update_id:100},state:{durableReplay:false}},{lastUpdateId:101}),true);
});

test('registration rejects older durable replays and fails closed without a valid cursor',()=>{
  assert.equal(isOlderRegistrationReplay({update:{update_id:100},state:{durableReplay:true}},{lastUpdateId:101}),true);
  assert.equal(isOlderRegistrationReplay({update:{update_id:100},state:{durableReplay:false}},{lastUpdateId:null}),true);
  assert.equal(isOlderRegistrationReplay({update:{update_id:100},state:{durableReplay:false}},{lastUpdateId:undefined}),true);
  assert.equal(isOlderRegistrationReplay({update:{update_id:NaN},state:{durableReplay:false}},{lastUpdateId:101}),true);
});

test('registration allows a later update and leaves equal cursor handling to the prompt path',()=>{
  assert.equal(isOlderRegistrationReplay({update:{update_id:102},state:{durableReplay:true}},{lastUpdateId:101}),false);
  assert.equal(isOlderRegistrationReplay({update:{update_id:101},state:{durableReplay:true}},{lastUpdateId:101}),false);
});

test('registration session advancement is an atomic monotonic cursor compare-and-set',()=>{
  const source=readFileSync(new URL('../../src/modules/participants/participant.repository.js',import.meta.url),'utf8');
  assert.match(source,/last_update_id=\? AND last_update_id<\?/);
  assert.match(source,/last_update_id=GREATEST\(COALESCE\(last_update_id,-1\),VALUES\(last_update_id\)\)/);
});


test('registration session save and advance refresh updated_at for a newer cursor',()=>{
  const source=readFileSync(new URL('../../src/modules/participants/participant.repository.js',import.meta.url),'utf8');
  assert.match(source,/updated_at=IF\(VALUES\(last_update_id\)>COALESCE\(last_update_id,-1\),CURRENT_TIMESTAMP,updated_at\)/);
  assert.match(source,/SET step=\?,payload=\?,last_update_id=\?,updated_at=CURRENT_TIMESTAMP WHERE telegram_user_id=\? AND step=\? AND last_update_id=\?/);
});


test('registration action callbacks are bound to the exact active session cursor',()=>{
  assert.equal(registrationSessionCursorMatches(null,-1),true);
  assert.equal(registrationSessionCursorMatches({lastUpdateId:100},100),true);
  assert.equal(registrationSessionCursorMatches({lastUpdateId:101},100),false);
  assert.equal(registrationSessionCursorMatches({lastUpdateId:null},-1),true);
  assert.equal(registrationSessionCursorMatches({lastUpdateId:100},-1),false);
  assert.equal(registrationSessionCursorMatches({lastUpdateId:100},'invalid'),false);
});

test('registration cancel callbacks carry the expected session cursor and delete conditionally',()=>{
  const keyboard=readFileSync(new URL('../../src/bot/keyboards/user.keyboard.js',import.meta.url),'utf8');
  const handler=readFileSync(new URL('../../src/bot/handlers/registration.handler.js',import.meta.url),'utf8');
  const repository=readFileSync(new URL('../../src/modules/participants/participant.repository.js',import.meta.url),'utf8');
  assert.match(keyboard,/registration:cancel:'\+String\(lastUpdateId===null\|\|lastUpdateId===undefined\?-1:/);
  assert.match(handler,/registration:cancel:\(-1\|\[0-9\]\{1,16\}\)/);
  assert.match(handler,/registrationSessionCursorMatches\(current,expectedCursor\)/);
  assert.match(repository,/DELETE FROM telegram_user_sessions WHERE telegram_user_id=\? AND last_update_id=\?/);
  assert.match(repository,/DELETE FROM telegram_user_sessions WHERE telegram_user_id=\? AND last_update_id IS NOT NULL AND last_update_id<\?/);
});


test('registration /cancel is scoped to registration steps and cannot clear a pending payment receipt session',()=>{
  assert.equal(isRegistrationSessionCancellable({step:'awaiting_name'}),true);
  assert.equal(isRegistrationSessionCancellable({step:'awaiting_phone'}),true);
  assert.equal(isRegistrationSessionCancellable({step:'awaiting_instagram'}),true);
  assert.equal(isRegistrationSessionCancellable({step:'awaiting_payment_receipt'}),false);
  assert.equal(isRegistrationSessionCancellable(null),false);
});


test('all registration routes defer active database-backed admins to later admin handlers',()=>{
  const source=readFileSync(new URL('../../src/bot/handlers/registration.handler.js',import.meta.url),'utf8');
  assert.match(source,/import \{hasPermission\} from '\.\.\/\.\.\/modules\/admin\/admin-role\.service\.js'/);
  assert.match(source,/async function isAdminAccount\(ctx\)\{\s*return hasPermission\(ctx\.from\?\.id,'dashboard\.read'\);\s*\}/);
  const registrations=[
    /bot\.action\('registration:start',async\(ctx,next\)=>\{\s*if\(await isAdminAccount\(ctx\)\)return next\(\);/,
    /bot\.action\(\/\^pa:.*?async\(ctx,next\)=>\{\s*if\(await isAdminAccount\(ctx\)\)return next\(\);/,
    /bot\.action\(\/\^registration:cancel:.*?async\(ctx,next\)=>\{\s*if\(await isAdminAccount\(ctx\)\)return next\(\);/,
    /bot\.command\('cancel',async\(ctx,next\)=>\{\s*if\(await isAdminAccount\(ctx\)\)return next\(\);/,
    /bot\.on\('contact',async\(ctx,next\)=>\{\s*if\(await isAdminAccount\(ctx\)\)return next\(\);/,
    /bot\.on\('text',async\(ctx,next\)=>\{\s*if\(await isAdminAccount\(ctx\)\)return next\(\);/
  ];
  for(const route of registrations)assert.match(source,route,'admin account must not be consumed by a participant registration route');
});
