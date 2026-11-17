import {pool} from '../../database/pool.js';

export async function getCampaignDrawProof(drawId){
  const id=Number(drawId);
  if(!Number.isSafeInteger(id)||id<1) throw new TypeError('Draw ID must be a positive safe integer.');
  const [[draw]]=await pool.execute(
    "SELECT id,campaign_id,status,algorithm,seed_hash,revealed_seed,candidate_snapshot_hash,candidate_count,winner_count,commitment_publication_reference,commitment_published_at,commitment_published_by,completed_at FROM campaign_draws WHERE id=?",
    [id]
  );
  if(!draw) throw new Error('قرعه‌کشی پیدا نشد.');
  if(draw.status!=='completed'||!draw.revealed_seed||!draw.completed_at) throw new Error('پرونده اثبات فقط پس از تکمیل قرعه‌کشی قابل دریافت است.');
  const [candidates]=await pool.execute(
    'SELECT id,draw_id,campaign_id,campaign_code_id,participant_id,code_snapshot,candidate_hash FROM draw_candidates WHERE draw_id=? ORDER BY id',
    [id]
  );
  const [winners]=await pool.execute(
    'SELECT campaign_code_id,participant_id,code_snapshot,rank_position FROM draw_winners WHERE draw_id=? ORDER BY rank_position',
    [id]
  );
  if(candidates.length!==Number(draw.candidate_count)||winners.length!==Number(draw.winner_count)) throw new Error('داده‌های Snapshot یا برندگان ناقص‌اند؛ ساخت پرونده اثبات متوقف شد.');
  return {
    proofVersion:1,
    draw:{
      id:Number(draw.id),campaignId:Number(draw.campaign_id),status:draw.status,algorithm:draw.algorithm,
      seedHash:draw.seed_hash,revealedSeed:draw.revealed_seed,candidateSnapshotHash:draw.candidate_snapshot_hash,
      candidateCount:Number(draw.candidate_count),winnerCount:Number(draw.winner_count),
      publication:{reference:draw.commitment_publication_reference,publishedAt:draw.commitment_published_at?new Date(draw.commitment_published_at).toISOString():null,publishedBy:draw.commitment_published_by?String(draw.commitment_published_by):null},
      completedAt:draw.completed_at?new Date(draw.completed_at).toISOString():null
    },
    candidates:candidates.map(row=>({
      id:Number(row.id),draw_id:Number(row.draw_id),campaign_id:Number(row.campaign_id),
      campaign_code_id:Number(row.campaign_code_id),participant_id:Number(row.participant_id),
      code_snapshot:row.code_snapshot,candidate_hash:row.candidate_hash
    })),
    winners:winners.map(row=>({
      campaign_code_id:Number(row.campaign_code_id),participant_id:Number(row.participant_id),
      code_snapshot:row.code_snapshot,rank_position:Number(row.rank_position)
    }))
  };
}
