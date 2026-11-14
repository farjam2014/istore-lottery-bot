'use strict';
const crypto = require('crypto');

function hashSnapshot(rows) {
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function shuffle(rows) {
  const out = rows.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function seedKey(secret) {
  if(!secret)throw new Error('کلید پایدار DRAW seed تنظیم نشده است.');
  return crypto.createHash('sha256').update(String(secret)).digest();
}
function encryptSeed(seed,secret) {
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',seedKey(secret),iv);
  const ciphertext=Buffer.concat([cipher.update(seed),cipher.final()]);
  return {iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};
}
function decryptSeed(encrypted,secret) {
  const decipher=crypto.createDecipheriv('aes-256-gcm',seedKey(secret),Buffer.from(encrypted.iv,'base64'));
  decipher.setAuthTag(Buffer.from(encrypted.tag,'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext,'base64')),decipher.final()]);
}
function shuffleWithSeed(rows,seed) {
  const out=rows.slice();let counter=0;
  const randomInt=max=>{
    if(!Number.isSafeInteger(max)||max<1||max>0x100000000)throw new Error('اندازه انتخاب تصادفی نامعتبر است.');
    const range=0x100000000,limit=Math.floor(range/max)*max;
    while(true){
      const digest=crypto.createHmac('sha256',seed).update('ustore-draw-v1:'+counter++).digest();
      const value=digest.readUInt32BE(0);
      if(value<limit)return value%max;
    }
  };
  for(let i=out.length-1;i>0;i--){const j=randomInt(i+1);[out[i],out[j]]=[out[j],out[i]];}
  return out;
}

function createDrawService({ db, adminId, seedSecret }) {
  async function prepareDraw(campaignId) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [[campaign]] = await conn.execute('SELECT * FROM campaigns WHERE id=? FOR UPDATE', [campaignId]);
      if (!campaign || campaign.status !== 'closed') throw new Error('برای آماده‌سازی قرعه‌کشی، کمپین باید بسته باشد.');
      const [[pending]] = await conn.execute(
        "SELECT COUNT(*) AS total FROM payment_orders WHERE campaign_id=? AND status IN ('pending_payment','receipt_submitted')",
        [campaignId]
      );
      if (Number(pending.total) > 0) throw new Error('ابتدا همه سفارش‌های پرداخت معلق را تعیین تکلیف کنید.');
      const [[activeDraw]] = await conn.execute(
        "SELECT id,status FROM campaign_draws WHERE campaign_id=? AND status IN ('prepared','running','pending_approval','completed') ORDER BY draw_number DESC LIMIT 1 FOR UPDATE",
        [campaignId]
      );
      if (activeDraw) {
        throw new Error('برای این کمپین قبلاً قرعه‌کشی آماده، در انتظار تأیید یا تکمیل‌شده وجود دارد؛ اجرای قرعه‌کشی مجدد مجاز نیست.');
      }
      const [[existing]] = await conn.execute('SELECT COALESCE(MAX(draw_number),0) AS last_number FROM campaign_draws WHERE campaign_id=?', [campaignId]);
      const drawNumber = Number(existing.last_number) + 1;
      const [created] = await conn.execute(
        "INSERT INTO campaign_draws(campaign_id,draw_number,method,status,draw_basis,multiple_win_policy,winner_count,alternate_count,algorithm_version,created_by) VALUES(?,?,?,'prepared',?,?,?,?,?,?)",
        [campaignId,drawNumber,campaign.draw_method,campaign.draw_basis,campaign.multiple_win_policy,campaign.winner_count,campaign.alternate_count,'istore-draw-v2',String(adminId)]
      );
      const drawId = created.insertId;
      let candidates;
      if (campaign.draw_basis === 'per_code') {
        const [rows] = await conn.execute(
          "SELECT cc.participant_id,cc.code FROM campaign_codes cc JOIN campaign_entries ce ON ce.id=cc.entry_id JOIN participants p ON p.id=cc.participant_id WHERE cc.campaign_id=? AND cc.status='active' AND ce.status='active' AND p.status='active' ORDER BY cc.code",
          [campaignId]
        );
        candidates = rows.map(x => ({ participant_id:x.participant_id,code:x.code,reference:'CODE:'+x.code }));
      } else {
        const [rows] = await conn.execute(
          "SELECT DISTINCT p.id AS participant_id FROM campaign_entries ce JOIN participants p ON p.id=ce.participant_id WHERE ce.campaign_id=? AND ce.status='active' AND p.status='active' AND EXISTS (SELECT 1 FROM campaign_codes cc WHERE cc.entry_id=ce.id AND cc.status='active') ORDER BY p.id",
          [campaignId]
        );
        candidates = rows.map(x => ({ participant_id:x.participant_id,code:null,reference:'PARTICIPANT:'+x.participant_id }));
      }
      if (!candidates.length) throw new Error('شرکت‌کننده واجد شرایطی برای قرعه‌کشی وجود ندارد.');
      const required = Number(campaign.winner_count) + Number(campaign.alternate_count);
      const maxSelectable = campaign.multiple_win_policy === 'allow' ? candidates.length : new Set(candidates.map(x=>String(x.participant_id))).size;
      if (maxSelectable < required) throw new Error('تعداد افراد واجد شرایط برای تعداد برندگان و ذخیره کافی نیست.');
      const snapshotHash = hashSnapshot(candidates);
      for (const candidate of candidates) {
        await conn.execute(
          "INSERT INTO draw_candidates(draw_id,participant_id,code,candidate_reference,eligibility) VALUES(?,?,?,?, 'eligible')",
          [drawId,candidate.participant_id,candidate.code,candidate.reference]
        );
      }
      let seedCommitment=null;
      if(['system','hybrid'].includes(campaign.draw_method)){
        const seed=crypto.randomBytes(32);
        seedCommitment=crypto.createHash('sha256').update(seed).digest('hex');
        const encrypted=encryptSeed(seed,seedSecret);
        await conn.execute('UPDATE campaign_draws SET snapshot_hash=?,seed_commitment=? WHERE id=?',[snapshotHash,seedCommitment,drawId]);
        await conn.execute(
          'INSERT INTO draw_evidence(draw_id,evidence_type,content_hash,description,recorded_by) VALUES(?,?,?,?,?)',
          [drawId,'draw_seed_encrypted',seedCommitment,JSON.stringify(encrypted),String(adminId)]
        );
      }else{
        await conn.execute('UPDATE campaign_draws SET snapshot_hash=? WHERE id=?',[snapshotHash,drawId]);
      }
      await conn.execute(
        'INSERT INTO draw_evidence(draw_id,evidence_type,content_hash,description,recorded_by) VALUES(?,?,?,?,?)',
        [drawId,'candidate_snapshot',snapshotHash,JSON.stringify({count:candidates.length,basis:campaign.draw_basis}),String(adminId)]
      );
      await conn.commit();
      return { drawId, drawNumber, candidates: candidates.length, snapshotHash, seedCommitment, method: campaign.draw_method };
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally { conn.release(); }
  }

  async function loadDrawCandidates(conn, drawId) {
    const [rows] = await conn.execute(
      "SELECT id,participant_id,code,candidate_reference FROM draw_candidates WHERE draw_id=? AND eligibility='eligible' ORDER BY candidate_reference",
      [drawId]
    );
    return rows;
  }

  async function storeWinners(conn, draw, candidates, selected, externalReference = null) {
    const primaryCount = Number(draw.winner_count);
    for (let i=0; i<selected.length; i++) {
      const candidate = selected[i];
      await conn.execute(
        'INSERT INTO draw_winners(draw_id,candidate_id,participant_id,code,winner_rank,winner_type,selection_method,external_reference) VALUES(?,?,?,?,?,?,?,?)',
        [draw.id,candidate.id,candidate.participant_id,candidate.code,i+1,i<primaryCount?'primary':'alternate',draw.method,externalReference]
      );
    }
  }

  async function runSystemDraw(drawId) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [[draw]] = await conn.execute('SELECT * FROM campaign_draws WHERE id=? FOR UPDATE', [drawId]);
      if (!draw || draw.status !== 'prepared' || !['system','hybrid'].includes(draw.method)) throw new Error('این قرعه‌کشی برای اجرای سیستمی آماده نیست.');
      const candidates = await loadDrawCandidates(conn,drawId);
      const [[seedEvidence]]=await conn.execute("SELECT description FROM draw_evidence WHERE draw_id=? AND evidence_type='draw_seed_encrypted' ORDER BY id DESC LIMIT 1 FOR UPDATE",[drawId]);
      if(!seedEvidence||!draw.seed_commitment)throw new Error('داده محرمانه و تعهد بذر قرعه‌کشی پیدا نشد؛ اجرای امن متوقف شد.');
      let encryptedSeed;
      try{encryptedSeed=typeof seedEvidence.description==='string'?JSON.parse(seedEvidence.description):seedEvidence.description;}catch{throw new Error('داده رمز‌شده بذر قرعه‌کشی خراب است.');}
      const seed=decryptSeed(encryptedSeed,seedSecret);
      const seedReveal=seed.toString('hex');
      const seedCommitment=crypto.createHash('sha256').update(seed).digest('hex');
      if(seedCommitment!==String(draw.seed_commitment))throw new Error('تعهد بذر با مقدار رمزگشایی‌شده مطابقت ندارد.');
      const required = Number(draw.winner_count) + Number(draw.alternate_count);
      const shuffled = shuffleWithSeed(candidates,seed);
      const selected = [];
      const seen = new Set();
      for (const candidate of shuffled) {
        const key = String(candidate.participant_id);
        if (draw.multiple_win_policy !== 'allow' && seen.has(key)) continue;
        selected.push(candidate);
        seen.add(key);
        if (selected.length === required) break;
      }
      if (selected.length !== required) throw new Error('تعداد برندگان قابل انتخاب کافی نیست.');
      await storeWinners(conn,draw,candidates,selected);
      await conn.execute(
        'INSERT INTO draw_evidence(draw_id,evidence_type,content_hash,description,recorded_by) VALUES(?,?,?,?,?)',
        [drawId,'seed_reveal',seedCommitment,JSON.stringify({seed:seedReveal,algorithm:'hmac-sha256-fisher-yates-v1',snapshot_hash:draw.snapshot_hash}),String(adminId)]
      );
      await conn.execute("UPDATE campaign_draws SET status='pending_approval' WHERE id=?", [drawId]);
      await conn.execute('INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)', [String(adminId),'prepare_system_draw_result','campaign_draw',String(drawId),JSON.stringify({candidate_count:candidates.length,selected:selected.map(x=>x.candidate_reference),snapshot_hash:draw.snapshot_hash,seed_commitment:seedCommitment,seed_reveal:seedReveal,algorithm:'hmac-sha256-fisher-yates-v1'})]);
      await conn.commit();
      return { drawId, status:'pending_approval', seedCommitment, seedReveal, algorithm:'hmac-sha256-fisher-yates-v1', winners:selected.map((x,i)=>({rank:i+1,participantId:x.participant_id,code:x.code,type:i<Number(draw.winner_count)?'primary':'alternate'})) };
    } catch (error) { await conn.rollback(); throw error; }
    finally { conn.release(); }
  }

  async function submitLiveWheelResults({ drawId, candidateReferences, externalReference, evidenceHash = null }) {
    if (!Array.isArray(candidateReferences) || !candidateReferences.length) throw new Error('فهرست نتایج گردونه خالی است.');
    const evidenceReference=String(externalReference||'').trim();
    if(evidenceReference.length<3||evidenceReference.length>255)throw new Error('برای ثبت نتیجه گردونه، لینک یا شناسه مدرک معتبر الزامی است.');
    if(evidenceHash!=null&&!/^[a-f0-9]{64}$/i.test(String(evidenceHash)))throw new Error('هش مدرک باید SHA-256 معتبر ۶۴ رقمی باشد.');
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [[draw]] = await conn.execute('SELECT * FROM campaign_draws WHERE id=? FOR UPDATE', [drawId]);
      if (!draw || draw.status !== 'prepared' || !['live_wheel','hybrid'].includes(draw.method)) throw new Error('این قرعه‌کشی برای ثبت نتیجه گردونه آماده نیست.');
      const candidates = await loadDrawCandidates(conn,drawId);
      const byRef = new Map(candidates.map(x=>[x.candidate_reference,x]));
      const selected = [];
      const seenCandidates = new Set();
      const seenParticipants = new Set();
      for (const ref of candidateReferences) {
        const candidate = byRef.get(String(ref));
        if (!candidate || seenCandidates.has(candidate.id)) throw new Error('نتیجه گردونه شامل ورودی نامعتبر یا تکراری است.');
        if (draw.multiple_win_policy !== 'allow' && seenParticipants.has(String(candidate.participant_id))) throw new Error('طبق سیاست کمپین، یک فرد نمی‌تواند بیش از یک رتبه بگیرد.');
        seenCandidates.add(candidate.id);
        seenParticipants.add(String(candidate.participant_id));
        selected.push(candidate);
      }
      const required = Number(draw.winner_count) + Number(draw.alternate_count);
      if (selected.length !== required) throw new Error('تعداد نتایج گردونه باید دقیقاً برابر مجموع برندگان اصلی و ذخیره باشد.');
      await storeWinners(conn,draw,candidates,selected,evidenceReference);
      await conn.execute("UPDATE campaign_draws SET status='pending_approval',external_reference=? WHERE id=?", [evidenceReference,drawId]);
      await conn.execute(
        'INSERT INTO draw_evidence(draw_id,evidence_type,reference_uri,content_hash,description,recorded_by) VALUES(?,?,?,?,?,?)',
        [drawId,'live_wheel_result',evidenceReference,evidenceHash,JSON.stringify({selected:candidateReferences}),String(adminId)]
      );
      await conn.execute('INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)', [String(adminId),'submit_live_draw_result','campaign_draw',String(drawId),JSON.stringify({selected:candidateReferences,snapshot_hash:draw.snapshot_hash})]);
      await conn.commit();
      return { drawId, status:'pending_approval' };
    } catch (error) { await conn.rollback(); throw error; }
    finally { conn.release(); }
  }

  async function approveDraw(drawId) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [[draw]] = await conn.execute('SELECT * FROM campaign_draws WHERE id=? FOR UPDATE', [drawId]);
      if (!draw || draw.status !== 'pending_approval') throw new Error('نتیجه قرعه‌کشی در انتظار تأیید نیست.');
      const [[campaign]] = await conn.execute('SELECT id,status FROM campaigns WHERE id=? FOR UPDATE', [draw.campaign_id]);
      if (!campaign || campaign.status !== 'closed') throw new Error('وضعیت کمپین تغییر کرده و امکان تأیید نتیجه وجود ندارد.');
      const [[winnerCount]] = await conn.execute('SELECT COUNT(*) AS total FROM draw_winners WHERE draw_id=?', [drawId]);
      if (Number(winnerCount.total) !== Number(draw.winner_count)+Number(draw.alternate_count)) throw new Error('تعداد نتایج ثبت‌شده ناقص است.');
      await conn.execute("UPDATE campaign_draws SET status='completed',approved_by=?,completed_at=UTC_TIMESTAMP() WHERE id=?", [String(adminId),drawId]);
      await conn.execute("UPDATE draw_winners SET approved_by=?,approved_at=UTC_TIMESTAMP() WHERE draw_id=?", [String(adminId),drawId]);
      const [recipients]=await conn.execute(
        'SELECT w.id,w.winner_rank,w.winner_type,w.participant_id,w.code,p.chat_id,p.business_connection_id,c.name AS campaign_name FROM draw_winners w JOIN participants p ON p.id=w.participant_id JOIN campaign_draws d ON d.id=w.draw_id JOIN campaigns c ON c.id=d.campaign_id WHERE w.draw_id=? ORDER BY w.winner_rank',
        [drawId]
      );
      for(const winner of recipients){
        if(!winner.chat_id)continue;
        const role=winner.winner_type==='primary'?'برنده اصلی':'برنده ذخیره';
        const code=winner.code?'\\nکد شرکت در قرعه‌کشی: '+winner.code:'';
        const payload={
          method:'sendMessage',
          payload:{
            chat_id:String(winner.chat_id),
            ...(winner.business_connection_id?{business_connection_id:String(winner.business_connection_id)}:{}),
            text:'🎉 نتیجه قرعه‌کشی USTORE\\n\\nتبریک! شما به‌عنوان '+role+' در کمپین «'+winner.campaign_name+'» انتخاب شده‌اید.\\nرتبه: '+winner.winner_rank+code+'\\n\\nبرای پیگیری با پشتیبانی ربات در ارتباط باشید.'
          }
        };
        await conn.execute(
          'INSERT IGNORE INTO telegram_notification_outbox(dedupe_key,notification_type,payload) VALUES(?,?,?)',
          ['draw-winner:'+drawId+':'+winner.id,'draw_winner_announcement',JSON.stringify(payload)]
        );
      }
      await conn.execute("UPDATE campaigns SET status='drawn' WHERE id=?", [draw.campaign_id]);
      await conn.execute('INSERT INTO campaign_status_history(campaign_id,from_status,to_status,actor,reason) VALUES(? ,\'closed\',\'drawn\',?,?)', [draw.campaign_id,String(adminId),'draw completed #'+drawId]);
      await conn.execute('INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)', [String(adminId),'approve_draw','campaign_draw',String(drawId),JSON.stringify({snapshot_hash:draw.snapshot_hash})]);
      await conn.commit();
      return { drawId, status:'completed' };
    } catch (error) { await conn.rollback(); throw error; }
    finally { conn.release(); }
  }

  return { prepareDraw, runSystemDraw, submitLiveWheelResults, approveDraw };
}

module.exports = { createDrawService, hashSnapshot, shuffle, shuffleWithSeed };
