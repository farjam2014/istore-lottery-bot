import test from 'node:test';
import assert from 'node:assert/strict';
import {setCampaignStatus} from '../../src/modules/campaigns/campaign-admin.service.js';

function fakeDatabase(campaign){
  const state={campaign:{...campaign},updates:[],audits:[],commits:0,rollbacks:0};
  const connection={
    async beginTransaction(){},
    async commit(){state.commits++;},
    async rollback(){state.rollbacks++;},
    release(){},
    async execute(sql,params=[]){
      if(sql.startsWith('SELECT status,(starts_at'))return [[state.campaign?{...state.campaign}:undefined].filter(Boolean),[]];
      if(sql.startsWith('UPDATE campaigns SET status=')){state.campaign.status=params[0];state.updates.push(params);return [{affectedRows:1},[]];}
      if(sql.startsWith('INSERT INTO admin_audit_log')){state.audits.push(params);return [{insertId:1},[]];}
      throw new Error('Unexpected SQL: '+sql);
    }
  };
  return {state,async getConnection(){return connection;}};
}

test('campaign activation changes status and audit atomically',async()=>{
  const db=fakeDatabase({status:'paused',not_started:0,already_ended:0});
  const result=await setCampaignStatus({campaignId:7,actorId:'99999',expectedStatus:'paused',action:'activate',database:db});
  assert.deepEqual({from:result.from,to:result.to,changed:result.changed},{from:'paused',to:'open',changed:true});
  assert.equal(db.state.updates.length,1);
  assert.equal(db.state.audits.length,1);
  assert.equal(db.state.commits,1);
});

test('replayed campaign action with an old expected status is rejected',async()=>{
  const db=fakeDatabase({status:'open',not_started:0,already_ended:0});
  await assert.rejects(setCampaignStatus({campaignId:7,actorId:'99999',expectedStatus:'paused',action:'activate',database:db}),/از زمان نمایش این دکمه تغییر کرده/);
  assert.equal(db.state.campaign.status,'open');
  assert.equal(db.state.updates.length,0);
  assert.equal(db.state.rollbacks,1);
});

test('campaign cannot be activated after its end time',async()=>{
  const db=fakeDatabase({status:'paused',not_started:0,already_ended:1});
  await assert.rejects(setCampaignStatus({campaignId:7,actorId:'99999',expectedStatus:'paused',action:'activate',database:db}),/زمان پایان کمپین گذشته/);
  assert.equal(db.state.updates.length,0);
  assert.equal(db.state.rollbacks,1);
});

test('future campaign activation remains scheduled',async()=>{
  const db=fakeDatabase({status:'draft',not_started:1,already_ended:0});
  const result=await setCampaignStatus({campaignId:7,actorId:'99999',expectedStatus:'draft',action:'activate',database:db});
  assert.equal(result.to,'scheduled');
  assert.equal(db.state.campaign.status,'scheduled');
});
