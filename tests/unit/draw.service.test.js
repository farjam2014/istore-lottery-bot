import test from 'node:test';
import assert from 'node:assert/strict';
import {rankDrawCandidates,DRAW_ALGORITHM} from '../../src/modules/draw/draw.service.js';

const candidates=[
  {id:3,draw_id:9,campaign_code_id:103,participant_id:33,code_snapshot:'P13-AB1234-X0'},
  {id:1,draw_id:9,campaign_code_id:101,participant_id:11,code_snapshot:'P13-AB1235-X0'},
  {id:2,draw_id:9,campaign_code_id:102,participant_id:22,code_snapshot:'P13-AB1236-X0'}
];

test('draw ranking is deterministic, independent of input ordering, and verifiable',()=>{
  const seed='a'.repeat(64);
  const first=rankDrawCandidates(seed,candidates);
  const second=rankDrawCandidates(seed,[...candidates].reverse());
  assert.equal(DRAW_ALGORITHM,'HMAC-SHA256 deterministic-rank-v1');
  assert.deepEqual(first.map(x=>x.id),second.map(x=>x.id));
  assert.ok(first.every(x=>/^[a-f0-9]{64}$/.test(x.ranking_hash)));
  assert.deepEqual(candidates.map(x=>x.id),[3,1,2],'Input snapshot must not be mutated.');
});

test('different committed seeds produce independently derived rankings',()=>{
  const first=rankDrawCandidates('a'.repeat(64),candidates).map(x=>x.id);
  const second=rankDrawCandidates('b'.repeat(64),candidates).map(x=>x.id);
  assert.notDeepEqual(first,second);
});

test('draw ranking rejects malformed seed material',()=>{
  assert.throws(()=>rankDrawCandidates('not-a-seed',candidates),/64 hexadecimal/);
});
