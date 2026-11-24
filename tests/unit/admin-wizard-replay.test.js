import test from 'node:test';
import assert from 'node:assert/strict';
import {isOlderAdminWizardReplay} from '../../src/modules/admin/admin-wizard-replay.js';

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
