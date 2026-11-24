import test from 'node:test';
import assert from 'node:assert/strict';
import {roleHasPermission,rolePermissions} from '../../src/modules/admin/permissions.js';

test('sensitive participant and payment exports are restricted to super admins',()=>{
  assert.equal(roleHasPermission('super_admin','participant.export'),true);
  assert.equal(roleHasPermission('super_admin','payment.export'),true);
  for(const role of ['campaign_manager','finance_manager']){
    assert.equal(roleHasPermission(role,'participant.read'),true);
    assert.equal(roleHasPermission(role,'participant.export'),false);
    assert.equal(roleHasPermission(role,'payment.export'),false);
    assert.equal(roleHasPermission(role,'participant.manage'),false);
  }
  assert.equal(roleHasPermission('support_agent','participant.read'),false);
  assert.ok(!rolePermissions.campaign_manager.includes('participant.export'));
});
