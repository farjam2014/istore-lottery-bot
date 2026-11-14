import test from 'node:test';
import assert from 'node:assert/strict';
import {reportRows} from '../../src/modules/reports/management-report.service.js';

test('campaign report export keeps only supported financial and participation fields',()=>{
  const rows=reportRows({topCampaigns:[{id:7,title:'Campaign',status:'open',participation_type:'paid',entry_price:250000,entries:12,eligible:9,paid_orders:8,revenue:2000000}]});
  assert.deepEqual(rows,[{campaign_id:7,title:'Campaign',status:'open',type:'paid',entry_price:250000,entries:12,eligible:9,approved_orders:8,revenue_irr:2000000}]);
});
test('empty campaign report exports as an empty row set',()=>{
  assert.deepEqual(reportRows({topCampaigns:[]}),[]);
});
