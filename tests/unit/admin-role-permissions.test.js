import test from 'node:test';
import assert from 'node:assert/strict';
import {roleHasPermission,permissionsForRole} from '../../src/modules/admin/permissions.js';

test('finance manager can review and decide payment receipts',()=>{
  assert.equal(roleHasPermission('finance_manager','payment.read'),true);
  assert.equal(roleHasPermission('finance_manager','payment.review'),true);
  assert.equal(permissionsForRole('finance_manager').includes('payment.review'),true);
});

test('campaign manager cannot approve or reject payment receipts',()=>{
  assert.equal(roleHasPermission('campaign_manager','payment.read'),false);
  assert.equal(roleHasPermission('campaign_manager','payment.review'),false);
});

test('support agent cannot access payment review operations',()=>{
  assert.equal(roleHasPermission('support_agent','payment.review'),false);
});
