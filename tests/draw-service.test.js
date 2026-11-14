'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {hashSnapshot,shuffle}=require('../src/draw-service');

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
