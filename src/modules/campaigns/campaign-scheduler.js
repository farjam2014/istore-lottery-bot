import {pool} from '../../database/pool.js';

export async function processCampaignSchedule({limit=100}={}){
  const c=await pool.getConnection();
  try{
    await c.beginTransaction();
    const [rows]=await c.execute(
      "SELECT id,status,starts_at,ends_at,(ends_at IS NOT NULL AND ends_at<=UTC_TIMESTAMP()) AS already_ended FROM campaigns WHERE (status='scheduled' AND starts_at<=UTC_TIMESTAMP()) OR (status='open' AND ends_at IS NOT NULL AND ends_at<=UTC_TIMESTAMP()) ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED",
      [Math.max(1,Math.min(500,Number(limit)||100))]
    );
    for(const campaign of rows){
      const next=campaign.status==='open'||Number(campaign.already_ended)===1?'closed':'open';
      await c.execute('UPDATE campaigns SET status=? WHERE id=? AND status=?',[next,campaign.id,campaign.status]);
      await c.execute(
        "INSERT INTO admin_audit_log(admin_telegram_id,action,entity_type,entity_id,details) VALUES(0,'campaign.auto_status_changed','campaign',?,?)",
        [campaign.id,JSON.stringify({from:campaign.status,to:next,source:'scheduler'})]
      );
    }
    await c.commit();
    return rows.length;
  }catch(error){await c.rollback();throw error;}finally{c.release();}
}
