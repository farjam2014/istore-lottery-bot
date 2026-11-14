'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {hashSnapshot,shuffle,shuffleWithSeed}=require('../src/draw-service');

test('snapshot hash is deterministic for the same ordered candidate list',()=>{
  const rows=[{participant_id:1,code:'LOT-AAAA',reference:'CODE:LOT-AAAA'},{participant_id:2,code:'LOT-BBBB',reference:'CODE:LOT-BBBB'}];
  assert.equal(hashSnapshot(rows),hashSnapshot(rows));
  assert.notEqual(hashSnapshot(rows),hashSnapshot(rows.slice().reverse()));
});

test('shuffle returns every candidate exactly once without mutating input',()=>{
  const input=Array.from({length:50},(_,i)=>({id:i}));
  const output=shuffle(input);
  assert.equal(output.length,input.length);
  assert.deepEqual(new Set(output.map(x=>x.id)),new Set(input.map(x=>x.id)));
  assert.deepEqual(input.map(x=>x.id),Array.from({length:50},(_,i)=>i));
});


test('prepareDraw refuses a second draw while an earlier draw is pending approval', async () => {
  const calls = [];
  const conn = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async execute(sql, params = []) {
      calls.push({sql, params});
      if (sql.includes('SELECT * FROM campaigns')) return [[{id:7,status:'closed',draw_method:'system',draw_basis:'per_code',multiple_win_policy:'one_per_participant',winner_count:1,alternate_count:0}], []];
      if (sql.includes('SELECT COUNT(*) AS total FROM payment_orders')) return [[{total:0}], []];
      if (sql.includes("status IN ('prepared','running','pending_approval','completed')")) return [[{id:12,status:'pending_approval'}], []];
      throw new Error('Unexpected SQL: '+sql);
    }
  };
  const service = require('../src/draw-service').createDrawService({
    db: { async getConnection() { return conn; } },
    adminId: '12345'
  });
  await assert.rejects(
    service.prepareDraw(7),
    /قرعه‌کشی مجدد مجاز نیست/
  );
  assert.equal(calls.some(x => x.sql.startsWith('INSERT INTO campaign_draws')), false);
});


test('live wheel result requires a traceable evidence reference and valid optional SHA-256', async () => {
  const service=require('../src/draw-service').createDrawService({db:{async getConnection(){throw new Error('must validate before connecting');}},adminId:'12345'});
  await assert.rejects(service.submitLiveWheelResults({drawId:1,candidateReferences:['CODE:A'],externalReference:'',evidenceHash:null}),/مدرک معتبر الزامی است/);
  await assert.rejects(service.submitLiveWheelResults({drawId:1,candidateReferences:['CODE:A'],externalReference:'https://example.com/video',evidenceHash:'bad'}),/SHA-256 معتبر/);
});

test('live wheel result is recorded with evidence and moves draw to pending approval', async () => {
  const calls=[];
  const conn={
    async beginTransaction(){calls.push('BEGIN');},async commit(){calls.push('COMMIT');},async rollback(){calls.push('ROLLBACK');},release(){},
    async execute(sql,params=[]){
      calls.push({sql,params});
      if(sql.includes('SELECT * FROM campaign_draws'))return [[{id:9,status:'prepared',method:'live_wheel',winner_count:1,alternate_count:0,multiple_win_policy:'one_per_participant',snapshot_hash:'abc'}]];
      if(sql.includes('FROM draw_candidates'))return [[{id:3,participant_id:22,code:'UST-ABC',candidate_reference:'CODE:UST-ABC'}]];
      return [{affectedRows:1,insertId:55}];
    }
  };
  const service=require('../src/draw-service').createDrawService({db:{async getConnection(){return conn;}},adminId:'12345'});
  const result=await service.submitLiveWheelResults({drawId:9,candidateReferences:['CODE:UST-ABC'],externalReference:'https://example.com/draw-video',evidenceHash:'a'.repeat(64)});
  assert.deepEqual(result,{drawId:9,status:'pending_approval'});
  assert.ok(calls.includes('COMMIT'));
  assert.ok(calls.some(x=>typeof x==='object'&&x.sql.includes('INSERT INTO draw_evidence')&&x.params[2]==='https://example.com/draw-video'&&x.params[3]==='a'.repeat(64)));
  assert.ok(calls.some(x=>typeof x==='object'&&x.sql.includes("UPDATE campaign_draws SET status='pending_approval'")));
});

test('approving a draw queues one idempotent Telegram notification per winner', async () => {
  const calls=[];
  const conn={
    async beginTransaction(){calls.push('BEGIN');},async commit(){calls.push('COMMIT');},async rollback(){calls.push('ROLLBACK');},release(){},
    async execute(sql,params=[]){
      calls.push({sql,params});
      if(sql.includes('SELECT * FROM campaign_draws'))return [[{id:12,campaign_id:4,status:'pending_approval',winner_count:1,alternate_count:0,snapshot_hash:'snapshot'}]];
      if(sql.includes('SELECT id,status FROM campaigns'))return [[{id:4,status:'closed'}]];
      if(sql.includes('SELECT COUNT(*) AS total FROM draw_winners'))return [[{total:1}]];
      if(sql.includes('SELECT w.id,w.winner_rank'))return [[{id:88,winner_rank:1,winner_type:'primary',participant_id:21,code:'UST-XYZ',chat_id:'700',business_connection_id:null,campaign_name:'کمپین تست'}]];
      return [{affectedRows:1}];
    }
  };
  const service=require('../src/draw-service').createDrawService({db:{async getConnection(){return conn;}},adminId:'12345'});
  const result=await service.approveDraw(12);
  assert.deepEqual(result,{drawId:12,status:'completed'});
  const queued=calls.find(x=>typeof x==='object'&&x.sql.includes('INSERT IGNORE INTO telegram_notification_outbox'));
  assert.ok(queued);
  assert.equal(queued.params[0],'draw-winner:12:88');
  const payload=JSON.parse(queued.params[2]);
  assert.equal(payload.payload.chat_id,'700');
  assert.match(payload.payload.text,/برنده اصلی/);
  assert.match(payload.payload.text,/UST-XYZ/);
  assert.ok(calls.includes('COMMIT'));
});


test('seeded shuffle is reproducible and preserves every candidate',()=>{
  const input=Array.from({length:80},(_,i)=>({id:i}));
  const seed=Buffer.from('ab'.repeat(32),'hex');
  const first=shuffleWithSeed(input,seed);
  const second=shuffleWithSeed(input,seed);
  const other=shuffleWithSeed(input,Buffer.from('cd'.repeat(32),'hex'));
  assert.deepEqual(first,second);
  assert.notDeepEqual(first,other);
  assert.deepEqual(new Set(first.map(x=>x.id)),new Set(input.map(x=>x.id)));
  assert.deepEqual(input.map(x=>x.id),Array.from({length:80},(_,i)=>i));
});

test('system draw stores an encrypted seed commitment and reveals the same seed after deterministic selection',async()=>{
  const calls=[];
  const secret='stable-session-secret-for-draw-proof';
  const candidates=[
    {id:1,participant_id:101,code:'UST-A',candidate_reference:'CODE:UST-A'},
    {id:2,participant_id:102,code:'UST-B',candidate_reference:'CODE:UST-B'},
    {id:3,participant_id:103,code:'UST-C',candidate_reference:'CODE:UST-C'}
  ];
  let encryptedSeed=null,commitment=null;
  const conn={
    async beginTransaction(){calls.push('BEGIN');},async commit(){calls.push('COMMIT');},async rollback(){calls.push('ROLLBACK');},release(){},
    async execute(sql,params=[]){
      calls.push({sql,params});
      if(sql.includes('SELECT * FROM campaigns'))return [[{id:7,status:'closed',draw_method:'system',draw_basis:'per_code',multiple_win_policy:'one_per_participant',winner_count:1,alternate_count:1}]];
      if(sql.includes('SELECT COUNT(*) AS total FROM payment_orders'))return [[{total:0}]];
      if(sql.includes("status IN ('prepared','running','pending_approval','completed')"))return [[],[]];
      if(sql.includes('COALESCE(MAX(draw_number)'))return [[{last_number:0}]];
      if(sql.startsWith('INSERT INTO campaign_draws'))return [{insertId:44}];
      if(sql.includes('SELECT cc.participant_id,cc.code'))return [[
        {participant_id:101,code:'UST-A'},
        {participant_id:102,code:'UST-B'},
        {participant_id:103,code:'UST-C'}
      ]];
      if(sql.includes('UPDATE campaign_draws SET snapshot_hash=?,seed_commitment=?')){commitment=params[1];return [{affectedRows:1}];}
      if(sql.includes("evidence_type='draw_seed_encrypted'"))return [[{description:encryptedSeed}]];
      if(sql.includes('SELECT * FROM campaign_draws'))return [[{id:44,status:'prepared',method:'system',winner_count:1,alternate_count:1,multiple_win_policy:'one_per_participant',snapshot_hash:'snapshot-hash',seed_commitment:commitment}]];
      if(sql.includes('FROM draw_candidates'))return [candidates,[]];
      if(sql.includes("evidence_type='draw_seed_encrypted'"))return [[{description:encryptedSeed}]];
      if(sql.includes('INSERT INTO draw_evidence')){if(params[1]==='draw_seed_encrypted')encryptedSeed=params[3];return [{affectedRows:1}];}
      return [{affectedRows:1,insertId:77}];
    }
  };
  const service=require('../src/draw-service').createDrawService({db:{async getConnection(){return conn;}},adminId:'admin',seedSecret:secret});
  const prepared=await service.prepareDraw(7);
  assert.equal(prepared.drawId,44);
  assert.match(prepared.seedCommitment,/^[a-f0-9]{64}$/);
  assert.ok(calls.some(x=>typeof x==='object'&&x.sql.includes("evidence_type,content_hash,description")&&x.params[1]==='draw_seed_encrypted'));
  const result=await service.runSystemDraw(44);
  assert.equal(result.seedCommitment,prepared.seedCommitment);
  assert.match(result.seedReveal,/^[a-f0-9]{64}$/);
  const crypto=require('node:crypto');
  assert.equal(crypto.createHash('sha256').update(Buffer.from(result.seedReveal,'hex')).digest('hex'),prepared.seedCommitment);
  assert.equal(result.algorithm,'hmac-sha256-fisher-yates-v1');
  assert.ok(calls.some(x=>typeof x==='object'&&x.sql.includes("evidence_type,content_hash,description")&&x.params[1]==='seed_reveal'));
  assert.ok(calls.includes('COMMIT'));
});
