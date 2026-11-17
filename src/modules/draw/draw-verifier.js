import {createHash,createHmac} from 'node:crypto';

export const DRAW_ALGORITHM='HMAC-SHA256 candidate-commitment-rank-v2';
export const DRAW_PROOF_VERSION=1;
const sha256=value=>createHash('sha256').update(value).digest('hex');

export function rankDrawCandidates(seed,candidates){
  if(!/^[a-f0-9]{64}$/i.test(String(seed))) throw new Error('Draw seed must be 32 bytes encoded as 64 hexadecimal characters.');
  if(!Array.isArray(candidates)) throw new TypeError('Candidates must be an array.');
  const key=Buffer.from(seed,'hex');
  return [...candidates].map(candidate=>({...candidate,ranking_hash:createHmac('sha256',key).update('draw:'+candidate.draw_id+':candidate:'+candidate.candidate_hash).digest('hex')})).sort((a,b)=>a.ranking_hash<b.ranking_hash?-1:a.ranking_hash>b.ranking_hash?1:(String(a.candidate_hash)<String(b.candidate_hash)?-1:String(a.candidate_hash)>String(b.candidate_hash)?1:0));
}

export function verifyCampaignDraw({drawId,algorithm,seed,seedHash,candidateSnapshotHash,candidates,winners}){
  if(algorithm!==DRAW_ALGORITHM) return {valid:false,reason:'unsupported_draw_algorithm'};
  const id=Number(drawId);
  if(!Number.isSafeInteger(id)||id<1) return {valid:false,reason:'invalid_draw_id'};
  if(!/^[a-f0-9]{64}$/i.test(String(seed??''))||sha256(String(seed))!==String(seedHash)) return {valid:false,reason:'seed_commitment_mismatch'};
  if(!Array.isArray(candidates)||!Array.isArray(winners)||!candidates.length||!winners.length||winners.some(winner=>!winner||typeof winner!=='object')) return {valid:false,reason:'invalid_draw_payload'};
  const candidateIds=new Set();const codeIds=new Set();
  const candidateIntegrity=candidates.every(candidate=>{
    if(!candidate||String(candidate.draw_id)!==String(id)) return false;
    const candidateId=String(candidate.id??'');const codeId=String(candidate.campaign_code_id??'');
    if(!/^\d+$/.test(candidateId)||!/^\d+$/.test(codeId)||!/^\d+$/.test(String(candidate.campaign_id??''))||!/^\d+$/.test(String(candidate.participant_id??''))||typeof candidate.code_snapshot!=='string'||!candidate.code_snapshot||! /^[a-f0-9]{64}$/i.test(String(candidate.candidate_hash??''))||candidateIds.has(candidateId)||codeIds.has(codeId)) return false;
    candidateIds.add(candidateId);codeIds.add(codeId);
    return sha256(candidate.draw_id+':'+candidate.campaign_id+':'+candidate.campaign_code_id+':'+candidate.participant_id+':'+candidate.code_snapshot)===String(candidate.candidate_hash);
  });
  if(!candidateIntegrity) return {valid:false,reason:'candidate_record_mismatch'};
  const snapshotHash=sha256(candidates.map(x=>x.candidate_hash).sort().join(''));
  if(snapshotHash!==String(candidateSnapshotHash)) return {valid:false,reason:'candidate_snapshot_mismatch',snapshotHash};
  const ranked=rankDrawCandidates(seed,candidates);const expected=[];const seen=new Set();
  for(const candidate of ranked){if(seen.has(String(candidate.participant_id))) continue;seen.add(String(candidate.participant_id));expected.push(candidate);if(expected.length===winners.length) break;}
  const actual=[...winners].sort((a,b)=>Number(a.rank_position)-Number(b.rank_position));
  const ranks=actual.every((winner,index)=>Number.isSafeInteger(Number(winner.rank_position))&&Number(winner.rank_position)===index+1);
  const same=ranks&&expected.length===actual.length&&expected.every((candidate,index)=>String(candidate.campaign_code_id)===String(actual[index].campaign_code_id)&&String(candidate.participant_id)===String(actual[index].participant_id)&&String(candidate.code_snapshot)===String(actual[index].code_snapshot));
  return {valid:same,snapshotHash,reason:same?null:'winner_selection_mismatch'};
}

export function verifyDrawProof(proof){
  if(!proof||typeof proof!=='object'||Array.isArray(proof)||proof.proofVersion!==DRAW_PROOF_VERSION||!proof.draw||typeof proof.draw!=='object') return {valid:false,reason:'unsupported_or_malformed_proof'};
  const draw=proof.draw;
  if(!Number.isSafeInteger(Number(draw.id))||Number(draw.id)<1||!Number.isSafeInteger(Number(draw.campaignId))||Number(draw.campaignId)<1) return {valid:false,reason:'invalid_draw_metadata'};
  if(draw.status!=='completed') return {valid:false,reason:'draw_not_completed'};
  if(!Number.isSafeInteger(Number(draw.candidateCount))||Number(draw.candidateCount)<1||!Number.isSafeInteger(Number(draw.winnerCount))||Number(draw.winnerCount)<1) return {valid:false,reason:'invalid_draw_counts'};
  if(!Array.isArray(proof.candidates)||proof.candidates.length!==Number(draw.candidateCount)||!Array.isArray(proof.winners)||proof.winners.length!==Number(draw.winnerCount)) return {valid:false,reason:'proof_count_mismatch'};
  if(proof.candidates.some(candidate=>String(candidate?.campaign_id)!==String(draw.campaignId))) return {valid:false,reason:'candidate_campaign_mismatch'};
  if(!draw.publication||typeof draw.publication.reference!=='string'||!/^https:\/\//i.test(draw.publication.reference)||!draw.publication.publishedAt||!draw.publication.publishedBy) return {valid:false,reason:'publication_metadata_missing'};
  return verifyCampaignDraw({drawId:draw.id,algorithm:draw.algorithm,seed:draw.revealedSeed,seedHash:draw.seedHash,candidateSnapshotHash:draw.candidateSnapshotHash,candidates:proof.candidates,winners:proof.winners});
}
