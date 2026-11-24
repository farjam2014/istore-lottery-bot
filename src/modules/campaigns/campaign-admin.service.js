import {pool} from '../../database/pool.js';

export async function archiveCampaign({campaignId,actorId}={}){
  const id=Number(campaignId);
  if(!Number.isSafeInteger(id)||id<1) throw new TypeError('Campaign ID must be a positive safe integer.');
  if(!/^\d+$/.test(String(actorId??''))) throw new TypeError('Archive actor must be a numeric Telegram user ID.');
  const connection=await pool.getConnection();
  try{
    await connection.beginTransaction();
    const [[campaign]]=await connection.execute('SELECT status FROM campaigns WHERE id=? FOR UPDATE',[id]);
    if(!campaign) throw new Error('کمپین پیدا نشد.');
    if(!['draft','paused','closed'].includes(campaign.status)) throw new Error('فقط کمپین پیش‌نویس، متوقف یا بسته قابل بایگانی است.');
    const [[activeDraw]]=await connection.execute(
      "SELECT id,status FROM campaign_draws WHERE campaign_id=? AND status IN ('prepared','completed') LIMIT 1 FOR UPDATE",
      [id]
    );
    if(activeDraw) throw new Error('کمپینی که قرعه‌کشی آماده یا تکمیل‌شده دارد قابل بایگانی نیست.');
    const [[eligibleEntries]]=await connection.execute(
      "SELECT COUNT(c.id) AS total FROM campaign_entries e JOIN participants p ON p.id=e.participant_id JOIN campaign_codes c ON c.campaign_entry_id=e.id WHERE e.campaign_id=? AND e.status='eligible' AND p.status='active' AND c.status='active'",
      [id]
    );
    if(Number(eligibleEntries.total)>0) throw new Error('کمپین دارای شرکت‌کنندگان واجد شرایط است؛ پیش از بایگانی باید قرعه‌کشی انجام شود یا وضعیت شرکت‌کنندگان تعیین تکلیف شود.');
    const [[pending]]=await connection.execute(
      "SELECT COUNT(*) AS total FROM payment_orders o JOIN campaign_entries e ON e.id=o.campaign_entry_id WHERE e.campaign_id=? AND (o.status='under_review' OR (o.status IN ('awaiting_receipt','rejected') AND o.expires_at>UTC_TIMESTAMP()))",
      [id]
    );
    if(Number(pending.total)>0) throw new Error('تا تعیین تکلیف سفارش‌های باز، بایگانی مجاز نیست.');
    await connection.execute("UPDATE campaigns SET status='archived' WHERE id=?",[id]);
    await connection.execute(
      'INSERT INTO admin_audit_log(admin_telegram_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)',
      [String(actorId),'campaign.archived','campaign',id,JSON.stringify({from:campaign.status,to:'archived'})]
    );
    await connection.commit();
    return {campaignId:id,from:campaign.status,to:'archived'};
  }catch(error){await connection.rollback();throw error;}
  finally{connection.release();}
}

export async function closeCampaign({campaignId,actorId}={}){
  const id=Number(campaignId);
  if(!Number.isSafeInteger(id)||id<1) throw new TypeError('Campaign ID must be a positive safe integer.');
  if(!/^\d+$/.test(String(actorId??''))) throw new TypeError('Campaign closer must be a numeric Telegram user ID.');
  const connection=await pool.getConnection();
  try{
    await connection.beginTransaction();
    const [[campaign]]=await connection.execute('SELECT status FROM campaigns WHERE id=? FOR UPDATE',[id]);
    if(!campaign) throw new Error('کمپین پیدا نشد.');
    if(!['open','paused','scheduled'].includes(campaign.status)) throw new Error('بستن دستی فقط برای کمپین فعال، متوقف یا زمان‌بندی‌شده مجاز است.');
    await connection.execute("UPDATE campaigns SET status='closed' WHERE id=?",[id]);
    await connection.execute(
      'INSERT INTO admin_audit_log(admin_telegram_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)',
      [String(actorId),'campaign.closed_manually','campaign',id,JSON.stringify({from:campaign.status,to:'closed'})]
    );
    await connection.commit();
    return {campaignId:id,from:campaign.status,to:'closed'};
  }catch(error){await connection.rollback();throw error;}
  finally{connection.release();}
}

export async function setCampaignStatus({campaignId,actorId,expectedStatus,action,database=pool}={}){
  const id=Number(campaignId);
  if(!Number.isSafeInteger(id)||id<1)throw new TypeError('Campaign ID must be a positive safe integer.');
  if(!/^\d+$/.test(String(actorId??'')))throw new TypeError('Campaign actor must be a numeric Telegram user ID.');
  if(!['draft','scheduled','paused','open'].includes(expectedStatus))throw new TypeError('Expected campaign status is invalid.');
  if(!['pause','activate'].includes(action))throw new TypeError('Campaign status action is invalid.');
  const connection=await database.getConnection();
  try{
    await connection.beginTransaction();
    const [[campaign]]=await connection.execute(
      'SELECT status,(starts_at IS NOT NULL AND starts_at>UTC_TIMESTAMP()) AS not_started,(ends_at IS NOT NULL AND ends_at<=UTC_TIMESTAMP()) AS already_ended FROM campaigns WHERE id=? FOR UPDATE',
      [id]
    );
    if(!campaign)throw new Error('کمپین پیدا نشد.');
    if(campaign.status!==expectedStatus)throw new Error('وضعیت کمپین از زمان نمایش این دکمه تغییر کرده است؛ جزئیات کمپین را تازه‌سازی کنید.');
    let nextStatus;
    if(action==='pause'){
      if(campaign.status!=='open')throw new Error('فقط کمپین فعال را می‌توان متوقف کرد.');
      nextStatus='paused';
    }else{
      if(!['draft','scheduled','paused'].includes(campaign.status))throw new Error('فعال‌سازی در وضعیت فعلی کمپین مجاز نیست.');
      if(Number(campaign.already_ended)===1)throw new Error('زمان پایان کمپین گذشته است؛ امکان فعال‌سازی وجود ندارد.');
      nextStatus=Number(campaign.not_started)===1?'scheduled':'open';
    }
    const changed=nextStatus!==campaign.status;
    if(changed){
      await connection.execute('UPDATE campaigns SET status=? WHERE id=?',[nextStatus,id]);
      await connection.execute(
        'INSERT INTO admin_audit_log(admin_telegram_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)',
        [String(actorId),'campaign.status_changed','campaign',id,JSON.stringify({from:campaign.status,to:nextStatus})]
      );
    }
    await connection.commit();
    return {campaignId:id,from:campaign.status,to:nextStatus,changed};
  }catch(error){await connection.rollback();throw error;}
  finally{connection.release();}
}
