import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCampaignCode} from '../../src/modules/entries/campaign-code.js';
test('campaign code keeps a fixed six-character middle section and two-character suffix',()=>{
  for(const sequenceNumber of [1,9,10,23,99,100,234,999,1000,2345,9999,10000,23456,99999,100000,123456,999999]){
    const code=buildCampaignCode({campaignId:13,sequenceNumber});
    assert.match(code,/^P13-[A-Z0-9]{6}-[A-Z0-9]{2}$/);
    const [,middle,suffix]=code.split('-');
    assert.equal(middle.length,6);assert.equal(suffix.length,2);
    assert.equal(middle.slice(-String(sequenceNumber).length),String(sequenceNumber));
    const randomPrefix=middle.slice(0,6-String(sequenceNumber).length);
    if(randomPrefix)assert.match(randomPrefix.at(-1),/^[A-Z0]$/);
    assert.match(suffix[1],/^[A-Z0]$/);
  }
});
test('random positions may contain digits but their final character cannot be 1 through 9',()=>{
  for(let i=0;i<500;i++){
    const code=buildCampaignCode({campaignId:13,sequenceNumber:99});
    const [,middle,suffix]=code.split('-');
    assert.match(middle.slice(0,4).at(-1),/^[A-Z0]$/);
    assert.match(suffix[1],/^[A-Z0]$/);
  }
});
test('campaign code rejects invalid campaign IDs and sequence values',()=>{
  for(const campaignId of [0,-1,'abc',''])assert.throws(()=>buildCampaignCode({campaignId,sequenceNumber:10001}));
  for(const sequenceNumber of [0,-1,1.5,1000000,NaN])assert.throws(()=>buildCampaignCode({campaignId:13,sequenceNumber}));
});
test('six-digit sequence has no random prefix',()=>{
  const code=buildCampaignCode({campaignId:13,sequenceNumber:123456});
  assert.match(code,/^P13-123456-[A-Z0-9][A-Z0]$/);
});

test('non-final random positions may use digits 1 through 9',()=>{
  const code=buildCampaignCode({campaignId:13,sequenceNumber:99,randomIntImpl:max=>max-1});
  assert.equal(code,'P13-999099-90');
});
