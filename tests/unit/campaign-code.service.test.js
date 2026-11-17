import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSequencePart,formatCampaignCode,generateCampaignCode,MAX_SEQUENCE_NUMBER} from '../../src/modules/codes/code-issuance.service.js';

test('six-character middle segment places sequence digits at the right edge',()=>{
  const cases=[[6,'ABCDG','ABCDG6'],[14,'ABCG','ABCG14'],[56,'ABCG','ABCG56'],[86,'ABDG','ABDG86'],[565,'ABG','ABG565'],[1434,'AG','AG1434'],[64467,'G','G64467'],[64,'ABCG','ABCG64'],[2,'ABCDG','ABCDG2'],[975465,'','975465'],[10001,'G','G10001'],[99999,'Z','Z99999'],[100000,'','100000'],[999999,'','999999']];
  for(const [sequence,prefix,expected] of cases) assert.equal(buildSequencePart(sequence,prefix),expected);
});

test('complete format uses campaign ID, six-character middle, and two-character suffix',()=>{
  assert.equal(formatCampaignCode({campaignId:13,sequenceNumber:14,randomPrefix:'ABCG',randomSuffix:'M8'}),'P13-ABCG14-M8');
  assert.equal(formatCampaignCode({campaignId:13,sequenceNumber:100000,randomPrefix:'',randomSuffix:'X0'}),'P13-100000-X0');
});

test('production generator starts at 10001 and emits allowed random characters',()=>{
  for(let i=0;i<500;i++){
    const generated=generateCampaignCode({campaignId:13,sequenceNumber:10001+i});
    assert.match(generated.code,/^P13-[A-Z0-9]{6}-[A-Z0-9][A-Z0]$/);
    assert.equal(generated.randomPrefix.length,1);
    assert.match(generated.randomPrefix,/^[ABCDEFGHJKLMNPQRSTUVWXYZ0]$/);
    assert.match(generated.randomSuffix,/^[ABCDEFGHJKLMNPQRSTUVWXYZ0123456789][ABCDEFGHJKLMNPQRSTUVWXYZ0]$/);
  }
  assert.throws(()=>generateCampaignCode({campaignId:13,sequenceNumber:10000}),/outside the allowed/);
  assert.throws(()=>generateCampaignCode({campaignId:13,sequenceNumber:MAX_SEQUENCE_NUMBER+1}),/outside the allowed/);
});

test('prefix and suffix validators reject malformed structures',()=>{
  assert.throws(()=>buildSequencePart(14,'ABC'),/does not match/);
  assert.throws(()=>formatCampaignCode({campaignId:13,sequenceNumber:14,randomPrefix:'ABCG',randomSuffix:'M8'}),/end with/ === false ? /end with/ : /never/);
});
