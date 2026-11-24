import test from 'node:test';
import assert from 'node:assert/strict';
import {createCampaignFromWizard,copyCampaign} from '../../src/modules/campaigns/campaign-admin.service.js';

function fakeDatabase({auditFails=false}={}){
  const state={wizard:{step:'confirm',payload:{type:'free',title:'Test Campaign',description:'Description',codes:2,capacity:null,starts_at:null,ends_at:null,draw_at:null}},source:{id:9,title:'Source',description:'Source description',poster_file_id:null,prize_title:null,prize_description:null,prize_value:null,participation_type:'free',entry_price:0,payment_methods:'[]',starts_at:null,ends_at:null,draw_at:null,terms:null,capacity:null,codes_per_entry:1},campaigns:[],audits:[],idempotency:null,commits:0,rollbacks:0,releases:0};
  let snapshot=null;
  const connection={
    async beginTransaction(){snapshot=JSON.parse(JSON.stringify(state));},
    async commit(){state.commits++;snapshot=null;},
    async rollback(){state.rollbacks++;if(snapshot){for(const key of Object.keys(state))delete state[key];Object.assign(state,snapshot);state.rollbacks++;snapshot=null;}},
    release(){state.releases++;},
    async execute(sql,params=[]){
      if(sql.startsWith('SELECT step,payload FROM admin_wizards'))return [[state.wizard?{step:state.wizard.step,payload:state.wizard.payload}:undefined].filter(Boolean),[]];
      if(sql.startsWith('SELECT * FROM campaigns WHERE id=? FOR UPDATE'))return [[state.source&&Number(params[0])===Number(state.source.id)?state.source:undefined].filter(Boolean),[]];
      if(sql.startsWith('INSERT IGNORE INTO admin_action_idempotency')){if(!state.idempotency)state.idempotency={idempotency_key:params[0],action_type:'campaign.copy',actor_telegram_id:params[1],entity_id:null};return [{affectedRows:1},[]];}
      if(sql.startsWith('SELECT action_type,actor_telegram_id,entity_id FROM admin_action_idempotency'))return [[state.idempotency?{...state.idempotency}:undefined].filter(Boolean),[]];
      if(sql.startsWith('INSERT INTO campaigns')){const id=state.campaigns.length+101;state.campaigns.push({id,params});return [{insertId:id},[]];}
      if(sql.startsWith('INSERT INTO admin_audit_log')){if(auditFails)throw new Error('audit unavailable');state.audits.push(params);return [{insertId:1},[]];}
      if(sql.startsWith('DELETE FROM admin_wizards')){state.wizard=null;return [{affectedRows:1},[]];}
      if(sql.startsWith('UPDATE admin_action_idempotency SET entity_id=')){state.idempotency.entity_id=params[0];return [{affectedRows:1},[]];}
      throw new Error('Unexpected SQL: '+sql);
    }
  };
  return {state,async getConnection(){return connection;}};
}

test('campaign wizard creation atomically inserts, audits, and consumes the wizard',async()=>{
  const database=fakeDatabase();
  const result=await createCampaignFromWizard({telegramUserId:'123',actorId:'123',database});
  assert.equal(result.campaignId,101);
  assert.equal(database.state.campaigns.length,1);
  assert.equal(database.state.audits.length,1);
  assert.equal(database.state.wizard,null);
  assert.equal(database.state.commits,1);
});

test('campaign wizard creation rolls back if audit insertion fails',async()=>{
  const database=fakeDatabase({auditFails:true});
  await assert.rejects(createCampaignFromWizard({telegramUserId:'123',actorId:'123',database}),/audit unavailable/);
  assert.equal(database.state.campaigns.length,0);
  assert.equal(database.state.wizard.step,'confirm');
  assert.equal(database.state.rollbacks,1);
});

test('a replayed campaign confirmation cannot create a second campaign',async()=>{
  const database=fakeDatabase();
  await createCampaignFromWizard({telegramUserId:'123',actorId:'123',database});
  await assert.rejects(createCampaignFromWizard({telegramUserId:'123',actorId:'123',database}),/منقضی شده/);
  assert.equal(database.state.campaigns.length,1);
});

test('campaign copy callback is idempotent for the same Telegram callback key',async()=>{
  const database=fakeDatabase();
  const idempotencyKey='a'.repeat(64);
  const first=await copyCampaign({campaignId:9,actorId:'123',idempotencyKey,database});
  const replay=await copyCampaign({campaignId:9,actorId:'123',idempotencyKey,database});
  assert.equal(first.campaignId,101);
  assert.equal(replay.campaignId,101);
  assert.equal(replay.alreadyProcessed,true);
  assert.equal(database.state.campaigns.length,1);
  assert.equal(database.state.audits.length,1);
});

test('campaign copy rolls back both copy and idempotency claim if audit fails',async()=>{
  const database=fakeDatabase({auditFails:true});
  await assert.rejects(copyCampaign({campaignId:9,actorId:'123',idempotencyKey:'b'.repeat(64),database}),/audit unavailable/);
  assert.equal(database.state.campaigns.length,0);
  assert.equal(database.state.idempotency,null);
  assert.equal(database.state.rollbacks,1);
});

test('campaign copy idempotency key cannot be reused by another actor',async()=>{
  const database=fakeDatabase();
  const key='c'.repeat(64);
  await copyCampaign({campaignId:9,actorId:'123',idempotencyKey:key,database});
  await assert.rejects(copyCampaign({campaignId:9,actorId:'999',idempotencyKey:key,database}),/معتبر نیست/);
  assert.equal(database.state.campaigns.length,1);
});

test('campaign copy truncates the source title to the campaigns.title limit',async()=>{
  const database=fakeDatabase();
  database.state.source.title='x'.repeat(180);
  const result=await copyCampaign({campaignId:9,actorId:'123',idempotencyKey:'d'.repeat(64),database});
  assert.equal(result.title.length,180);
  assert.ok(result.title.endsWith(' (نسخه کپی)'));
});

test('campaign slug retains Persian letters instead of collapsing them to an empty slug',async()=>{
  const database=fakeDatabase();
  database.state.wizard.payload.title='کمپین آزمایشی زرند';
  await createCampaignFromWizard({telegramUserId:'123',actorId:'123',database});
  assert.match(database.state.campaigns[0].params[0],/کمپین-آزمایشی-زرند-[a-f0-9]{6}/);
});
