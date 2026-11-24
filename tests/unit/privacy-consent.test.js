import test from 'node:test';
import assert from 'node:assert/strict';
import {envSchema} from '../../src/config/env-schema.js';
import {isRegistrationUpdateAllowed} from '../../src/bot/middleware/registration-gate.js';
import {buildPrivacyAcceptedSession} from '../../src/bot/handlers/registration.handler.js';

const base={
  NODE_ENV:'production',BOT_TOKEN:'12345678901234567890:test-token',BOT_ADMIN_IDS:'123',
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
  assert.equal(isRegistrationUpdateAllowed({callbackData:'privacy:accept'}),true);
  assert.equal(isRegistrationUpdateAllowed({message:{text:'my phone'},session:null}),false);
});

test('re-accepting a privacy notice preserves an in-progress registration step and collected data',()=>{
  const existing={step:'awaiting_instagram',payload:{fullName:'Test User',phone:'+989121234567',privacyConsentVersion:'old-v1'}};
  const next=buildPrivacyAcceptedSession(existing,'new-v2');
  assert.equal(next.step,'awaiting_instagram');
  assert.deepEqual(next.payload,{fullName:'Test User',phone:'+989121234567',privacyConsentVersion:'new-v2'});
});

test('first privacy acceptance starts a new registration at the name step',()=>{
  assert.deepEqual(buildPrivacyAcceptedSession(null,'v1'),{step:'awaiting_name',payload:{privacyConsentVersion:'v1'}});
});
