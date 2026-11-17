import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {rankDrawCandidates,verifyCampaignDraw,verifyDrawProof,isValidPublicationReference,DRAW_ALGORITHM,DRAW_PROOF_VERSION} from '../../src/modules/draw/draw-verifier.js';

const seed='c'.repeat(64);
const candidates=[
  {id:3,draw_id:9,campaign_id:13,campaign_code_id:103,participant_id:33,code_snapshot:'P13-AB1234-X0'},
  {id:1,draw_id:9,campaign_id:13,campaign_code_id:101,participant_id:11,code_snapshot:'P13-AB1235-X0'},
  {id:2,draw_id:9,campaign_id:13,campaign_code_id:102,participant_id:22,code_snapshot:'P13-AB1236-X0'}
].map(candidate=>({...candidate,candidate_hash:createHash('sha256').update(candidate.draw_id+':'+candidate.campaign_id+':'+candidate.campaign_code_id+':'+candidate.participant_id+':'+candidate.code_snapshot).digest('hex')}));
const snapshotHash=createHash('sha256').update(candidates.map(x=>x.candidate_hash).sort().join('')).digest('hex');
const ranked=rankDrawCandidates(seed,candidates);
const winners=ranked.slice(0,2).map((x,index)=>({campaign_code_id:x.campaign_code_id,participant_id:x.participant_id,code_snapshot:x.code_snapshot,rank_position:index+1}));
const proof={
  proofVersion:DRAW_PROOF_VERSION,
  draw:{id:9,campaignId:13,status:'completed',algorithm:DRAW_ALGORITHM,seedHash:createHash('sha256').update(seed).digest('hex'),revealedSeed:seed,candidateSnapshotHash:snapshotHash,candidateCount:3,winnerCount:2,publication:{reference:'https://example.com/draw/9',publishedAt:'2026-11-17T10:00:00.000Z',publishedBy:'admin'},completedAt:'2026-11-17T10:01:00.000Z'},
  candidates,winners
};

test('publication references require a real HTTPS URL without embedded credentials',()=>{
  assert.equal(isValidPublicationReference('https://example.com/draw/9'),true);
  assert.equal(isValidPublicationReference('http://example.com/draw/9'),false);
  assert.equal(isValidPublicationReference('https://'),false);
  assert.equal(isValidPublicationReference('https://!!!!!!!!'),false);
  assert.equal(isValidPublicationReference('https://-bad.example/draw/9'),false);
  assert.equal(isValidPublicationReference('https://127.0.0.1/draw/9'),true);
  assert.equal(isValidPublicationReference('https://[::1]/draw/9'),true);
  assert.equal(isValidPublicationReference('https://user:secret@example.com/draw/9'),false);
  assert.equal(isValidPublicationReference(' https://example.com/draw/9'),false);
  assert.equal(isValidPublicationReference('https://example.com/'+('a'.repeat(490))),false);
});

test('offline proof verifies without database or encryption key',()=>{
  const result=verifyDrawProof(proof);
  assert.equal(result.valid,true);
  assert.equal(result.snapshotHash,snapshotHash);
});
test('proof rejects altered seed, candidate list, winner, algorithm and missing publication',()=>{
  const alteredSeed=structuredClone(proof);alteredSeed.draw.revealedSeed='d'.repeat(64);
  assert.equal(verifyDrawProof(alteredSeed).reason,'seed_commitment_mismatch');
  const alteredCandidate=structuredClone(proof);alteredCandidate.candidates[0].code_snapshot='TAMPERED';
  assert.equal(verifyDrawProof(alteredCandidate).reason,'candidate_record_mismatch');
  const alteredWinner=structuredClone(proof);alteredWinner.winners[0].participant_id=999;
  assert.equal(verifyDrawProof(alteredWinner).reason,'winner_selection_mismatch');
  const unknownAlgorithm=structuredClone(proof);unknownAlgorithm.draw.algorithm='legacy';
  assert.equal(verifyDrawProof(unknownAlgorithm).reason,'unsupported_draw_algorithm');
  const unpublished=structuredClone(proof);unpublished.draw.publication=null;
  assert.equal(verifyDrawProof(unpublished).reason,'publication_metadata_missing');
  const badUrl=structuredClone(proof);badUrl.draw.publication.reference='http://example.com';
  assert.equal(verifyDrawProof(badUrl).reason,'publication_metadata_missing');
  const badTimestamp=structuredClone(proof);badTimestamp.draw.completedAt='not-a-date';
  assert.equal(verifyDrawProof(badTimestamp).reason,'publication_metadata_missing');
  const latePublication=structuredClone(proof);latePublication.draw.publication.publishedAt='2026-11-17T10:02:00.000Z';
  assert.equal(verifyDrawProof(latePublication).reason,'publication_metadata_missing');
  const credentialUrl=structuredClone(proof);credentialUrl.draw.publication.reference='https://user:secret@example.com/draw/9';
  assert.equal(verifyDrawProof(credentialUrl).reason,'publication_metadata_missing');
  const wrongCampaign=structuredClone(proof);wrongCampaign.draw.campaignId=14;
  assert.equal(verifyDrawProof(wrongCampaign).reason,'candidate_campaign_mismatch');
});
test('proof rejects truncated, duplicated and malformed payloads',()=>{
  const truncated=structuredClone(proof);truncated.candidates.pop();
  assert.equal(verifyDrawProof(truncated).reason,'proof_count_mismatch');
  const duplicate=structuredClone(proof);duplicate.candidates.push(duplicate.candidates[0]);duplicate.draw.candidateCount++;
  assert.equal(verifyDrawProof(duplicate).reason,'candidate_record_mismatch');
  assert.equal(verifyDrawProof('{bad json').valid,false);
  assert.equal(verifyDrawProof({...proof,proofVersion:99}).reason,'unsupported_or_malformed_proof');
});

test('offline CLI accepts a valid proof and rejects a tampered proof',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'ustore-draw-proof-'));
  const file=join(directory,'proof.json');
  try{
    await writeFile(file,JSON.stringify(proof));
    const valid=spawnSync(process.execPath,['scripts/verify-draw-proof.js',file],{encoding:'utf8'});
    assert.equal(valid.status,0,valid.stderr);
    assert.equal(JSON.parse(valid.stdout).valid,true);
    const tampered=structuredClone(proof);tampered.draw.revealedSeed='e'.repeat(64);
    await writeFile(file,JSON.stringify(tampered));
    const invalid=spawnSync(process.execPath,['scripts/verify-draw-proof.js',file],{encoding:'utf8'});
    assert.equal(invalid.status,1);
    assert.equal(JSON.parse(invalid.stdout).valid,false);
  }finally{await rm(directory,{recursive:true,force:true});}
});
