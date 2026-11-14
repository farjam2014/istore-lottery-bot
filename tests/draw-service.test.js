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
