import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {rankDrawCandidates,verifyCampaignDraw,DRAW_ALGORITHM} from '../../src/modules/draw/draw.service.js';

const candidates=[
  {id:3,draw_id:9,campaign_id:13,campaign_code_id:103,participant_id:33,code_snapshot:'P13-AB1234-X0'},
  {id:1,draw_id:9,campaign_id:13,campaign_code_id:101,participant_id:11,code_snapshot:'P13-AB1235-X0'},
  {id:2,draw_id:9,campaign_id:13,campaign_code_id:102,participant_id:22,code_snapshot:'P13-AB1236-X0'}
].map(candidate=>({...candidate,candidate_hash:createHash('sha256').update(candidate.draw_id+':'+candidate.campaign_id+':'+candidate.campaign_code_id+':'+candidate.participant_id+':'+candidate.code_snapshot).digest('hex')}));

test('draw ranking is deterministic, independent of input ordering, and verifiable',()=>{
  const seed='a'.repeat(64);
  const first=rankDrawCandidates(seed,candidates);
  const second=rankDrawCandidates(seed,[...candidates].reverse());
  assert.equal(DRAW_ALGORITHM,'HMAC-SHA256 candidate-commitment-rank-v2');
  assert.deepEqual(first.map(x=>x.candidate_hash),second.map(x=>x.candidate_hash));
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

test('public verifier checks seed commitment and reproducible unique-participant winners',()=>{
  const seed='c'.repeat(64);
  const snapshot=candidates.map(candidate=>({...candidate,candidate_hash:createHash('sha256').update(candidate.draw_id+':'+candidate.campaign_id+':'+candidate.campaign_code_id+':'+candidate.participant_id+':'+candidate.code_snapshot).digest('hex')}));
  const candidateSnapshotHash=createHash('sha256').update(snapshot.map(x=>x.candidate_hash).sort().join('')).digest('hex');
  const ranked=rankDrawCandidates(seed,snapshot);
  const chosen=[];const participants=new Set();
  for(const candidate of ranked){
    if(participants.has(String(candidate.participant_id))) continue;
    participants.add(String(candidate.participant_id));
    chosen.push({...candidate,rank_position:chosen.length+1});
    if(chosen.length===2) break;
  }
  const commitment=createHash('sha256').update(seed).digest('hex');
  const result=verifyCampaignDraw({drawId:9,algorithm:DRAW_ALGORITHM,seed,seedHash:commitment,candidateSnapshotHash,candidates:snapshot,winners:chosen});
  assert.equal(result.valid,true);
  assert.match(result.snapshotHash,/^[a-f0-9]{64}$/);
  const altered=verifyCampaignDraw({drawId:9,algorithm:DRAW_ALGORITHM,seed:'d'.repeat(64),seedHash:commitment,candidateSnapshotHash,candidates:snapshot,winners:chosen});
  assert.equal(altered.valid,false);
  assert.equal(altered.reason,'seed_commitment_mismatch');
  const changedSnapshot=verifyCampaignDraw({drawId:9,algorithm:DRAW_ALGORITHM,seed,seedHash:commitment,candidateSnapshotHash:'0'.repeat(64),candidates:snapshot,winners:chosen});
  assert.equal(changedSnapshot.valid,false);assert.equal(changedSnapshot.reason,'candidate_snapshot_mismatch');
  const wrongDraw=verifyCampaignDraw({drawId:10,algorithm:DRAW_ALGORITHM,seed,seedHash:commitment,candidateSnapshotHash,candidates:snapshot,winners:chosen});
  assert.equal(wrongDraw.valid,false);assert.equal(wrongDraw.reason,'candidate_record_mismatch');
  const changedDatabaseIds=snapshot.map((x,index)=>({...x,id:x.id+1000+index}));
  assert.equal(verifyCampaignDraw({drawId:9,algorithm:DRAW_ALGORITHM,seed,seedHash:commitment,candidateSnapshotHash,candidates:changedDatabaseIds,winners:chosen}).valid,true,'Ranking must not depend on mutable candidate row IDs.');
  const alteredWinnerRanks=chosen.map((x,index)=>({...x,rank_position:index+2}));
  assert.equal(verifyCampaignDraw({drawId:9,algorithm:DRAW_ALGORITHM,seed,seedHash:commitment,candidateSnapshotHash,candidates:snapshot,winners:alteredWinnerRanks}).reason,'winner_selection_mismatch');
  const duplicateCandidate=[...snapshot,snapshot[0]];
  assert.equal(verifyCampaignDraw({drawId:9,algorithm:DRAW_ALGORITHM,seed,seedHash:commitment,candidateSnapshotHash,candidates:duplicateCandidate,winners:chosen}).reason,'candidate_record_mismatch');
  assert.equal(verifyCampaignDraw({drawId:9,algorithm:'legacy',seed,seedHash:commitment,candidateSnapshotHash,candidates:snapshot,winners:chosen}).reason,'unsupported_draw_algorithm');
});
