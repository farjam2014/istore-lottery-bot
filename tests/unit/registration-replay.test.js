import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isOlderRegistrationReplay} from '../../src/bot/handlers/registration.handler.js';

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
  assert.match(source,/last_update_id IS NOT NULL AND last_update_id<\?/);
  assert.match(source,/last_update_id=GREATEST\(COALESCE\(last_update_id,-1\),VALUES\(last_update_id\)\)/);
});
