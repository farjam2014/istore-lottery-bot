import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSequencePart,formatCampaignCode,generateCampaignCode,MAX_SEQUENCE_NUMBER,MIN_SEQUENCE_NUMBER,normalizeRequestedCodeCount} from '../../src/modules/codes/code-issuance.service.js';

test('six-character middle segment places sequence digits at the right edge from sequence 1',()=>{
  const cases=[[1,'ABCDE','ABCDE1'],[5,'ABCD0','ABCD05'],[9,'ABCD0','ABCD09'],[10,'ABCD','ABCD10'],[56,'ABC0','ABC056'],[99,'ABC0','ABC099'],[100,'ABC','ABC100'],[999,'AB0','AB0999'],[1000,'AB','AB1000'],[9999,'A0','A09999'],[10000,'A','A10000'],[99999,'Z','Z99999'],[100000,'','100000'],[999999,'','999999']];
  for(const [sequence,prefix,expected] of cases) assert.equal(buildSequencePart(sequence,prefix),expected);
  assert.equal(MIN_SEQUENCE_NUMBER,1);
});

test('complete format uses campaign ID, six-character middle, and two-character suffix',()=>{
  assert.equal(formatCampaignCode({campaignId:13,sequenceNumber:1,randomPrefix:'ABCDE',randomSuffix:'MZ'}),'P13-ABCDE1-MZ');
  assert.equal(formatCampaignCode({campaignId:13,sequenceNumber:100000,randomPrefix:'',randomSuffix:'X0'}),'P13-100000-X0');
});

test('production generator starts at 1 and emits the exact allowed random alphabets',()=>{
  for(let sequence=1;sequence<=500;sequence++){
    const generated=generateCampaignCode({campaignId:13,sequenceNumber:sequence});
    assert.match(generated.code,/^P13-[A-Z0-9]{6}-[A-Z0-9][A-Z0]$/);
    assert.equal(generated.randomPrefix.length,6-String(sequence).length);
    assert.match(generated.randomPrefix,/^[ABCDEFGHJKLMNPQRSTUVWXYZ0123456789]*[A-Z0]$/);
    assert.match(generated.randomSuffix,/^[ABCDEFGHJKLMNPQRSTUVWXYZ0123456789][A-Z0]$/);
  }
  assert.throws(()=>generateCampaignCode({campaignId:13,sequenceNumber:0}),/outside the allowed/);
  assert.throws(()=>generateCampaignCode({campaignId:13,sequenceNumber:MAX_SEQUENCE_NUMBER+1}),/outside the allowed/);
});

test('generator handles every digit-width boundary and maximum sequence',()=>{
  const cases=[[5,5],[9,5],[10,4],[56,4],[99,4],[100,3],[999,3],[1000,2],[9999,2],[10000,1],[99999,1],[100000,0],[999999,0]];
  for(const [sequence,prefixLength] of cases){
    const generated=generateCampaignCode({campaignId:13,sequenceNumber:sequence});
    assert.equal(generated.randomPrefix.length,prefixLength);
    assert.equal(generated.code.split('-')[1].length,6);
  }
  assert.throws(()=>generateCampaignCode({campaignId:0,sequenceNumber:1}),/Campaign ID/);
});

test('prefix and suffix validators reject malformed structures and forbidden final digits',()=>{
  assert.throws(()=>buildSequencePart(10,'ABC'),/does not match/);
  assert.equal(buildSequencePart(10,'ABCI'),'ABCI10');
  assert.throws(()=>buildSequencePart(10,'ABC5'),/disallowed characters/);
  assert.throws(()=>formatCampaignCode({campaignId:13,sequenceNumber:10,randomPrefix:'ABCD',randomSuffix:'M8'}),/Random suffix/);
  assert.equal(formatCampaignCode({campaignId:13,sequenceNumber:10,randomPrefix:'ABCD',randomSuffix:'O0'}),'P13-ABCD10-O0');
  assert.equal(formatCampaignCode({campaignId:13,sequenceNumber:10,randomPrefix:'ABCI',randomSuffix:'I0'}),'P13-ABCI10-I0');
});

test('requested issuance count must be an integer from 1 through 100',()=>{
  assert.equal(normalizeRequestedCodeCount(1),1);
  assert.equal(normalizeRequestedCodeCount('100'),100);
  for(const invalid of [0,-1,101,1.5,'abc',null,undefined,true,false,{},[]]) assert.throws(()=>normalizeRequestedCodeCount(invalid),/integer between 1 and 100/);
});
