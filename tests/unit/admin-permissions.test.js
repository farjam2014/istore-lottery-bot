import test from 'node:test';
import assert from 'node:assert/strict';
import {roleHasPermission,rolePermissions,assignableRoles} from '../../src/modules/admin/permissions.js';

test('super admin has every permission',()=>{
  for(const permission of ['dashboard.read','campaign.write','participant.manage','payment.review','support.manage','report.read'])assert.equal(roleHasPermission('super_admin',permission),true);
});
test('campaign manager is limited to campaigns and participant read',()=>{
  assert.equal(roleHasPermission('campaign_manager','campaign.write'),true);
  assert.equal(roleHasPermission('campaign_manager','participant.read'),true);
  assert.equal(roleHasPermission('campaign_manager','campaign.draw'),false);
  for(const permission of ['payment.review','payment.settings','support.reply','support.manage','report.read','participant.manage'])assert.equal(roleHasPermission('campaign_manager',permission),false);
});
test('finance manager can review payments but cannot manage campaigns or support',()=>{
  for(const permission of ['payment.read','payment.review','payment.settings','payment.export','report.read'])assert.equal(roleHasPermission('finance_manager',permission),true);
  assert.equal(roleHasPermission('finance_manager','participant.read'),false);
  assert.equal(roleHasPermission('finance_manager','participant.directory.read'),false);
  for(const permission of ['campaign.write','support.reply','support.manage','participant.manage'])assert.equal(roleHasPermission('finance_manager',permission),false);
});
test('support agent can manage tickets but cannot access finance or campaigns',()=>{
  for(const permission of ['support.read','support.reply','support.manage'])assert.equal(roleHasPermission('support_agent',permission),true);
  assert.equal(roleHasPermission('support_agent','participant.read'),false);
  for(const permission of ['payment.read','payment.review','payment.settings','campaign.write','report.read','participant.manage'])assert.equal(roleHasPermission('support_agent',permission),false);
});
test('only non-super-admin roles are assignable from the role UI',()=>{
  assert.deepEqual(assignableRoles,['campaign_manager','finance_manager','support_agent']);
});
