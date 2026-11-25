import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {privacyNoticeKeyboard} from '../../src/bot/keyboards/user.keyboard.js';
import {envSchema} from '../../src/config/env-schema.js';
import {isRegistrationUpdateAllowed} from '../../src/bot/middleware/registration-gate.js';
import {isPrivacyGateCallbackAllowed} from '../../src/bot/middleware/profile-gate.js';
import {buildPrivacyAcceptedSession,isOlderRegistrationReplay} from '../../src/bot/handlers/registration.handler.js';

const base={
  NODE_ENV:'production',BOT_TOKEN:'12345678901234567890:test-token',BOT_ADMIN_IDS:'123456789',
  MYSQL_HOST:'127.0.0.1',MYSQL_PORT:'3306',MYSQL_DATABASE:'ustore_test',MYSQL_USER:'ustore',MYSQL_PASSWORD:'test'
};

test('production configuration requires a published privacy notice URL and version',()=>{
  assert.equal(envSchema.safeParse(base).success,false);
  assert.equal(envSchema.safeParse({...base,PRIVACY_NOTICE_URL:'https://ustore.ir/privacy-notice',PRIVACY_NOTICE_VERSION:'v1'}).success,true);
});

test('non-production configuration can omit the privacy notice while developing',()=>{
  assert.equal(envSchema.safeParse({...base,NODE_ENV:'test'}).success,true);
});

test('privacy notice acceptance callback is allowed before a participant profile exists',()=>{
  assert.equal(isRegistrationUpdateAllowed({callbackData:'privacy:accept'}),false);
  assert.equal(isRegistrationUpdateAllowed({callbackData:'pa:-1:v1'}),true);
  assert.equal(isRegistrationUpdateAllowed({message:{text:'my phone'},session:null}),false);
});

test('cursor-bound privacy and cancellation callbacks pass the registration gate',()=>{
  assert.equal(isRegistrationUpdateAllowed({callbackData:'pa:-1:v1'}),true);
  assert.equal(isRegistrationUpdateAllowed({callbackData:'pa:12345:v1'}),true);
  assert.equal(isRegistrationUpdateAllowed({callbackData:'registration:cancel:-1'}),true);
  assert.equal(isRegistrationUpdateAllowed({callbackData:'registration:cancel:12345'}),true);
  assert.equal(isRegistrationUpdateAllowed({callbackData:'pa:not-a-cursor'}),false);
  assert.equal(isRegistrationUpdateAllowed({callbackData:'registration:cancel'}),false);
});

test('re-accepting a privacy notice preserves an in-progress registration step and collected data',()=>{
  const existing={step:'awaiting_instagram',payload:{fullName:'Test User',phone:'+989121234567',privacyConsentVersion:'old-v1',privacyConsentAt:'2026-11-20T09:00:00.000Z'},lastUpdateId:101};
  const next=buildPrivacyAcceptedSession(existing,'new-v2','2026-11-25T11:00:00.000Z',150);
  assert.equal(next.step,'awaiting_instagram');
  assert.equal(next.lastUpdateId,150);
  assert.deepEqual(next.payload,{fullName:'Test User',phone:'+989121234567',privacyConsentVersion:'new-v2',privacyConsentAt:'2026-11-25T11:00:00.000Z'});
});

test('first privacy acceptance starts a new registration at the name step',()=>{
  assert.deepEqual(buildPrivacyAcceptedSession(null,'v1','2026-11-25T11:00:00.000Z',200),{step:'awaiting_name',payload:{privacyConsentVersion:'v1',privacyConsentAt:'2026-11-25T11:00:00.000Z'},lastUpdateId:200});
});

test('an older retried registration message cannot be mistaken for input to a later step',()=>{
  const session={step:'awaiting_instagram',lastUpdateId:101};
  assert.equal(isOlderRegistrationReplay({state:{durableReplay:true},update:{update_id:100}},session),true);
  assert.equal(isOlderRegistrationReplay({state:{durableReplay:false},update:{update_id:100}},session),true);
  assert.equal(isOlderRegistrationReplay({state:{durableReplay:true},update:{update_id:102}},session),false);
  assert.equal(isOlderRegistrationReplay({state:{durableReplay:true},update:{update_id:101}},session),false);
});

test('reaccepting the same privacy notice version preserves the original consent timestamp',()=>{
  const existing={step:'awaiting_phone',payload:{privacyConsentVersion:'v1',privacyConsentAt:'2026-11-20T09:00:00.000Z'},lastUpdateId:500};
  const next=buildPrivacyAcceptedSession(existing,'v1','2026-11-25T11:00:00.000Z',501);
  assert.equal(next.payload.privacyConsentAt,'2026-11-20T09:00:00.000Z');
  assert.equal(next.lastUpdateId,501);
});

test('invalid privacy acceptance timestamps are rejected',()=>{
  assert.throws(()=>buildPrivacyAcceptedSession(null,'v1','not-a-date',100),/timestamp must be valid/);
});

test('privacy re-acceptance records the current callback update as the replay cursor',()=>{
  const handler=readFileSync(new URL('../../src/bot/handlers/registration.handler.js',import.meta.url),'utf8');
  const repository=readFileSync(new URL('../../src/modules/participants/participant.repository.js',import.meta.url),'utf8');
  assert.match(handler,/acceptPrivacyConsentSession\(\{telegramUserId:ctx\.from\.id,expectedLastUpdateId:expectedCursor,updateId:ctx\.update\.update_id,version,acceptedAt:new Date\(\)\}\)/);
  assert.match(handler,/registrationSessionCursorMatches\(existingSession,expectedCursor\)/);
  assert.match(repository,/SELECT step,payload,last_update_id FROM telegram_user_sessions WHERE telegram_user_id=\? FOR UPDATE/);
  assert.match(repository,/WHERE telegram_user_id=\? AND last_update_id <=> \?/);
  assert.match(repository,/last_update_id=\? AND last_update_id<\?/);
});

test('privacy acceptance requires a valid Telegram update ID',()=>{
  assert.throws(()=>buildPrivacyAcceptedSession(null,'v1','2026-11-25T11:00:00.000Z',NaN),/update ID must be a safe integer/);
});

test('privacy consent callback binds the exact notice version and remains within Telegram callback limits',()=>{
  const markup=privacyNoticeKeyboard('https://ustore.ir/privacy',1234567890123456,'notice-version-2026.11').reply_markup;
  const callback=markup.inline_keyboard.flat().find(button=>button.text==='خواندم و می‌پذیرم').callback_data;
  assert.equal(callback,'pa:1234567890123456:notice-version-2026.11');
  assert.ok(Buffer.byteLength(callback,'utf8')<=64);
});
test('handler rejects consent callbacks issued for a superseded privacy notice',()=>{
  const handler=readFileSync(new URL('../../src/bot/handlers/registration.handler.js',import.meta.url),'utf8');
  assert.ok(handler.includes('bot.action(/^pa:(-1|[0-9]{1,16}):([A-Za-z0-9._-]{1,40})$/'));
  assert.match(handler,/callbackVersion!==version/);
});

test('existing profiles can pass only the version-bound privacy re-consent callback through the profile gate',()=>{
  assert.equal(isPrivacyGateCallbackAllowed('pa:12345:notice_2026.11'),true);
  assert.equal(isPrivacyGateCallbackAllowed('pa:-1:v1'),true);
  assert.equal(isPrivacyGateCallbackAllowed('registration:cancel:12345'),true);
  assert.equal(isPrivacyGateCallbackAllowed('privacy:accept:12345'),false);
  assert.equal(isPrivacyGateCallbackAllowed('pa:not-a-cursor:v1'),false);
  assert.equal(isPrivacyGateCallbackAllowed('pa:12345:'),false);
});

test('every registration and profile-gate privacy prompt supplies the configured notice version',()=>{
  const files=[
    '../../src/bot/handlers/registration.handler.js',
    '../../src/bot/middleware/profile-gate.js'
  ];
  for(const file of files){
    const source=readFileSync(new URL(file,import.meta.url),'utf8');
    const calls=[...source.matchAll(/privacyNoticeKeyboard\(([^)]*)\)/g)];
    assert.ok(calls.length>0,file+' must contain a privacy prompt');
    for(const call of calls)assert.match(call[1],/config\.PRIVACY_NOTICE_VERSION/,file+' has a privacy keyboard call without a notice version');
  }
});
