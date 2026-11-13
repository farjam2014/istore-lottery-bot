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
