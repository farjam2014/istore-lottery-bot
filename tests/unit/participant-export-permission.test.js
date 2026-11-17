import test from 'node:test';
import assert from 'node:assert/strict';
import {roleHasPermission,rolePermissions} from '../../src/modules/admin/permissions.js';

test('participant export is restricted to super admins',()=>{
  assert.equal(roleHasPermission('super_admin','participant.export'),true);
  for(const role of ['campaign_manager','finance_manager','support_agent']){
    assert.equal(roleHasPermission(role,'participant.read'),true);
    assert.equal(roleHasPermission(role,'participant.export'),false);
    assert.equal(roleHasPermission(role,'participant.manage'),false);
  }
  assert.ok(!rolePermissions.campaign_manager.includes('participant.export'));
});
