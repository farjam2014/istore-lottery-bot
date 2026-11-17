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
    const [[pending]]=await connection.execute(
      "SELECT COUNT(*) AS total FROM payment_orders o JOIN campaign_entries e ON e.id=o.campaign_entry_id WHERE e.campaign_id=? AND o.status IN ('awaiting_receipt','under_review','rejected')",
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
