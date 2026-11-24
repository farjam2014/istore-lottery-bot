import test from 'node:test';
import assert from 'node:assert/strict';
import {roleHasPermission,rolePermissions} from '../../src/modules/admin/permissions.js';

test('sensitive participant and payment exports are restricted to super admins',()=>{
  assert.equal(roleHasPermission('super_admin','participant.export'),true);
  assert.equal(roleHasPermission('super_admin','payment.export'),true);
  assert.equal(roleHasPermission('campaign_manager','participant.read'),true);
  for(const role of ['campaign_manager','finance_manager']){
    if(role==='finance_manager')assert.equal(roleHasPermission(role,'participant.read'),false);
    assert.equal(roleHasPermission(role,'participant.export'),false);
    assert.equal(roleHasPermission(role,'payment.export'),false);
    assert.equal(roleHasPermission(role,'participant.manage'),false);
  }
  assert.equal(roleHasPermission('support_agent','participant.read'),false);
  for(const role of ['campaign_manager','finance_manager','support_agent'])assert.equal(roleHasPermission(role,'participant.directory.read'),false);
  assert.ok(!rolePermissions.campaign_manager.includes('participant.export'));
});
