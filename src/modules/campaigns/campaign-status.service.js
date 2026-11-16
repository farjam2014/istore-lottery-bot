import {pool} from '../../database/pool.js';

export async function setCampaignStatus({campaignId,actorId,target}){
  if(!['activate','pause'].includes(target))throw new Error('درخواست تغییر وضعیت کمپین معتبر نیست.');
  const actor=String(actorId??'');
  if(!/^[0-9]+$/.test(actor))throw new Error('شناسه مدیر معتبر نیست.');
  const c=await pool.getConnection();
  try{
    await c.beginTransaction();
    const [[row]]=await c.execute(
      'SELECT id,status,starts_at,ends_at,(starts_at IS NOT NULL AND starts_at>UTC_TIMESTAMP()) AS not_started,(ends_at IS NOT NULL AND ends_at<=UTC_TIMESTAMP()) AS already_ended FROM campaigns WHERE id=? FOR UPDATE',
      [campaignId]
    );
    if(!row)throw new Error('کمپین پیدا نشد.');

    let next=row.status;
    if(target==='pause'){
      if(row.status==='paused') {
        await c.commit();
        return {changed:false,from:row.status,to:row.status};
      }
      if(!['open','scheduled'].includes(row.status))throw new Error('فقط کمپین فعال یا زمان‌بندی‌شده قابل توقف است.');
      next=Number(row.already_ended)===1?'closed':'paused';
    }else{
      if(!['draft','scheduled','paused','open'].includes(row.status))throw new Error('کمپین بسته یا بایگانی‌شده قابل فعال‌سازی نیست.');
      if(Number(row.already_ended)===1)next='closed';
      else if(row.status==='open'||(row.status==='scheduled'&&Number(row.not_started)===1)){
        await c.commit();
        return {changed:false,from:row.status,to:row.status};
      }else next=Number(row.not_started)===1?'scheduled':'open';
    }

    if(next!==row.status){
      await c.execute('UPDATE campaigns SET status=? WHERE id=? AND status=?',[next,campaignId,row.status]);
      await c.execute(
        'INSERT INTO admin_audit_log(admin_telegram_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)',
        [actor,'campaign.status_changed','campaign',campaignId,JSON.stringify({from:row.status,to:next,source:'admin'})]
      );
    }
    await c.commit();
    return {changed:next!==row.status,from:row.status,to:next};
  }catch(error){
    await c.rollback();
    throw error;
  }finally{
    c.release();
  }
}
