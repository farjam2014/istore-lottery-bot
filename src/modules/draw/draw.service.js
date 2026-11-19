import {createHash,randomBytes} from 'node:crypto';
import {encryptDrawSeed,decryptDrawSeed} from './draw-keyring.js';
import {pool} from '../../database/pool.js';

export {DRAW_ALGORITHM,rankDrawCandidates,verifyCampaignDraw} from './draw-verifier.js';
import {DRAW_ALGORITHM,rankDrawCandidates,isValidPublicationReference} from './draw-verifier.js';
const MAX_WINNERS=100;

const sha256=value=>createHash('sha256').update(value).digest('hex');

export async function prepareCampaignDraw({campaignId,createdBy,winnerCount=1}){
  const count=Number(winnerCount);
  if(!Number.isSafeInteger(count)||count<1||count>MAX_WINNERS) throw new RangeError('Winner count must be between 1 and 100.');
  if(!/^\d+$/.test(String(createdBy??''))) throw new Error('Draw creator must be a numeric Telegram user ID.');
  const seed=randomBytes(32).toString('hex');
  const commitment=sha256(seed);
  const encrypted=encryptDrawSeed(seed);
  const connection=await pool.getConnection();
  try{
    await connection.beginTransaction();
    const [[campaign]]=await connection.execute("SELECT id,status FROM campaigns WHERE id=? FOR UPDATE",[campaignId]);
    if(!campaign) throw new Error('کمپین پیدا نشد.');
    if(campaign.status!=='closed') throw new Error('برای قرعه‌کشی، کمپین باید بسته شده باشد.');
    const [[pendingEntries]]=await connection.execute("SELECT COUNT(*) AS total FROM campaign_entries WHERE campaign_id=? AND status='pending_payment'",[campaignId]);
    if(Number(pendingEntries.total)>0) throw new Error('تا تعیین تکلیف تمام ثبت‌نام‌های در انتظار پرداخت، آماده‌سازی قرعه‌کشی مجاز نیست.');
    const [[pendingOrders]]=await connection.execute(
      "SELECT COUNT(*) AS total FROM payment_orders o JOIN campaign_entries e ON e.id=o.campaign_entry_id WHERE e.campaign_id=? AND (o.status='under_review' OR (o.status IN ('awaiting_receipt','rejected') AND o.expires_at>UTC_TIMESTAMP()))",
      [campaignId]
    );
    if(Number(pendingOrders.total)>0) throw new Error('تا تعیین تکلیف تمام سفارش‌های پرداختی فعال، آماده‌سازی قرعه‌کشی مجاز نیست.');
    const [[existing]]=await connection.execute("SELECT id FROM campaign_draws WHERE campaign_id=? AND status IN ('prepared','completed') LIMIT 1 FOR UPDATE",[campaignId]);
    if(existing) throw new Error('برای این کمپین قبلاً قرعه‌کشی آماده یا تکمیل شده است.');
    const [candidates]=await connection.execute(
      "SELECT cc.id AS campaign_code_id,cc.campaign_entry_id,cc.code,e.participant_id FROM campaign_codes cc JOIN campaign_entries e ON e.id=cc.campaign_entry_id AND e.campaign_id=cc.campaign_id JOIN participants p ON p.id=e.participant_id WHERE cc.campaign_id=? AND cc.status='active' AND e.status='eligible' AND p.status='active' ORDER BY cc.id FOR UPDATE",
      [campaignId]
    );
    if(candidates.length<count) throw new Error('تعداد کدهای واجد شرایط از تعداد برندگان کمتر است.');
    if(new Set(candidates.map(x=>String(x.participant_id))).size<count) throw new Error('تعداد شرکت‌کنندگان یکتای واجد شرایط از تعداد برندگان کمتر است.');
    const [drawInsert]=await connection.execute(
      "INSERT INTO campaign_draws(campaign_id,status,algorithm,seed_hash,candidate_count,winner_count,created_by,seed_ciphertext,seed_nonce,seed_tag,seed_key_id) VALUES(?,'prepared',?,?,?,?,?,?,?,?,?)",
      [campaignId,DRAW_ALGORITHM,commitment,candidates.length,count,String(createdBy),encrypted.ciphertext,encrypted.nonce,encrypted.tag,encrypted.keyId]
    );
    const drawId=drawInsert.insertId;
    const candidateHashes=[];
    for(const candidate of candidates){
      const candidateHash=sha256(drawId+':'+campaignId+':'+candidate.campaign_code_id+':'+candidate.participant_id+':'+candidate.code);
      candidateHashes.push(candidateHash);
      await connection.execute(
        'INSERT INTO draw_candidates(draw_id,campaign_id,campaign_code_id,campaign_entry_id,participant_id,code_snapshot,candidate_hash) VALUES(?,?,?,?,?,?,?)',
        [drawId,campaignId,candidate.campaign_code_id,candidate.campaign_entry_id,candidate.participant_id,candidate.code,candidateHash]
      );
    }
    const snapshotHash=sha256(candidateHashes.sort().join(''));
    await connection.execute('UPDATE campaign_draws SET candidate_snapshot_hash=? WHERE id=?',[snapshotHash,drawId]);
    await connection.execute(
      "INSERT INTO admin_audit_log(admin_telegram_id,action,entity_type,entity_id,details) VALUES(?,'draw_prepared','campaign_draw',?,?)",
      [String(createdBy),drawId,JSON.stringify({campaignId,candidateCount:candidates.length,winnerCount:count,algorithm:DRAW_ALGORITHM,seedHash:commitment,candidateSnapshotHash:snapshotHash})]
    );
    await connection.commit();
    return {drawId,campaignId:Number(campaignId),status:'prepared',algorithm:DRAW_ALGORITHM,seedHash:commitment,candidateSnapshotHash:snapshotHash,candidateCount:candidates.length,winnerCount:count};
  }catch(error){await connection.rollback();throw error;}finally{connection.release();}
}

export async function completeCampaignDraw({drawId,completedBy}){
  if(!/^\d+$/.test(String(completedBy??''))) throw new Error('Draw completer must be a numeric Telegram user ID.');
  const connection=await pool.getConnection();
  try{
    await connection.beginTransaction();
    // Keep the global lock order consistent with prepareCampaignDraw:
    // campaign first, then draw. This avoids a campaign/draw lock inversion.
    const [[drawReference]]=await connection.execute('SELECT campaign_id FROM campaign_draws WHERE id=?',[drawId]);
    if(!drawReference) throw new Error('قرعه‌کشی پیدا نشد.');
    const [[campaign]]=await connection.execute('SELECT id,status FROM campaigns WHERE id=? FOR UPDATE',[drawReference.campaign_id]);
    const [[draw]]=await connection.execute('SELECT * FROM campaign_draws WHERE id=? AND campaign_id=? FOR UPDATE',[drawId,drawReference.campaign_id]);
    if(!draw) throw new Error('قرعه‌کشی پیدا نشد.');
    if(draw.status!=='prepared') throw new Error('فقط قرعه‌کشی آماده قابل اجرا است.');
    if(!draw.commitment_published_at||!isValidPublicationReference(draw.commitment_publication_reference)||!draw.commitment_published_by) throw new Error('پیش از اجرای قرعه‌کشی باید انتشار عمومی Commitment با لینک HTTPS ثبت شود.');
    if(draw.algorithm!==DRAW_ALGORITHM) throw new Error('نسخه الگوریتم این قرعه‌کشی با نسخه فعال سازگار نیست؛ اجرای آن متوقف شد تا قرعه‌کشی با نسخه صحیح بازبینی شود.');
    if(!campaign||campaign.status!=='closed') throw new Error('وضعیت کمپین برای تکمیل قرعه‌کشی معتبر نیست.');
    const [candidates]=await connection.execute(
      'SELECT dc.id,dc.draw_id,dc.campaign_id,dc.campaign_code_id,dc.campaign_entry_id,dc.participant_id,dc.code_snapshot,dc.candidate_hash,cc.code AS current_code,cc.status AS code_status,e.status AS entry_status,p.status AS participant_status FROM draw_candidates dc LEFT JOIN campaign_codes cc ON cc.id=dc.campaign_code_id AND cc.campaign_id=dc.campaign_id AND cc.campaign_entry_id=dc.campaign_entry_id LEFT JOIN campaign_entries e ON e.id=dc.campaign_entry_id AND e.campaign_id=dc.campaign_id AND e.participant_id=dc.participant_id LEFT JOIN participants p ON p.id=e.participant_id WHERE dc.draw_id=? ORDER BY dc.id FOR UPDATE',
      [drawId]
    );
    if(candidates.length!==Number(draw.candidate_count)||!candidates.length) throw new Error('Snapshot نامزدهای قرعه‌کشی ناقص یا دستکاری شده است.');
    for(const candidate of candidates){
      const expectedHash=sha256(draw.id+':'+draw.campaign_id+':'+candidate.campaign_code_id+':'+candidate.participant_id+':'+candidate.code_snapshot);
      if(String(candidate.campaign_id)!==String(draw.campaign_id)||expectedHash!==candidate.candidate_hash) throw new Error('اطلاعات یکی از نامزدهای Snapshot دستکاری شده است.');
      if(candidate.code_status!=='active'||candidate.entry_status!=='eligible'||candidate.participant_status!=='active'||candidate.current_code!==candidate.code_snapshot) throw new Error('وضعیت یکی از کدها یا شرکت‌کنندگان پس از آماده‌سازی قرعه‌کشی تغییر کرده است؛ قرعه‌کشی متوقف شد.');
    }
    const actualSnapshot=sha256(candidates.map(x=>x.candidate_hash).sort().join(''));
    if(actualSnapshot!==draw.candidate_snapshot_hash) throw new Error('Hash فهرست نامزدها با Snapshot ثبت‌شده مطابقت ندارد.');
    const seed=decryptDrawSeed(draw);
    if(sha256(seed)!==draw.seed_hash) throw new Error('Seed قرعه‌کشی با Commitment اولیه مطابقت ندارد.');
    const ranked=rankDrawCandidates(seed,candidates);
    const winners=[];
    const participants=new Set();
    for(const candidate of ranked){
      if(participants.has(String(candidate.participant_id))) continue;
      participants.add(String(candidate.participant_id));
      winners.push(candidate);
      if(winners.length===Number(draw.winner_count)) break;
    }
    if(winners.length!==Number(draw.winner_count)) throw new Error('تعداد شرکت‌کنندگان یکتای واجد شرایط برای برندگان کافی نیست.');
    for(let index=0;index<winners.length;index++){
      const winner=winners[index];
      await connection.execute(
        'INSERT INTO draw_winners(draw_id,campaign_id,campaign_code_id,campaign_entry_id,participant_id,candidate_id,code_snapshot,rank_position) VALUES(?,?,?,?,?,?,?,?)',
        [drawId,draw.campaign_id,winner.campaign_code_id,winner.campaign_entry_id,winner.participant_id,winner.id,winner.code_snapshot,index+1]
      );
    }
    await connection.execute(
      "UPDATE campaign_draws SET status='completed',revealed_seed=?,completed_at=UTC_TIMESTAMP() WHERE id=?",
      [seed,drawId]
    );
    await connection.execute("UPDATE campaigns SET status='drawn' WHERE id=? AND status='closed'",[draw.campaign_id]);
    await connection.execute(
      "INSERT INTO admin_audit_log(admin_telegram_id,action,entity_type,entity_id,details) VALUES(?,'draw_completed','campaign_draw',?,?)",
      [String(completedBy),drawId,JSON.stringify({campaignId:Number(draw.campaign_id),winnerCount:winners.length,seedHash:draw.seed_hash,candidateSnapshotHash:draw.candidate_snapshot_hash,winners:winners.map((x,index)=>({rank:index+1,code:x.code_snapshot,participantId:Number(x.participant_id)}))})]
    );
    await connection.commit();
    return {drawId:Number(drawId),campaignId:Number(draw.campaign_id),status:'completed',algorithm:draw.algorithm,seedHash:draw.seed_hash,revealedSeed:seed,candidateSnapshotHash:draw.candidate_snapshot_hash,candidateCount:candidates.length,winners:winners.map((x,index)=>({rank:index+1,code:x.code_snapshot,participantId:Number(x.participant_id)}))};
  }catch(error){await connection.rollback();throw error;}finally{connection.release();}
}
