import {pool} from '../../database/pool.js';
import {issueCampaignCodes,normalizeRequestedCodeCount} from '../codes/code-issuance.service.js';

async function getIssuedCodeCount(connection,campaignId){
  const [[row]]=await connection.execute("SELECT COUNT(*) AS total FROM campaign_codes WHERE campaign_id=?",[campaignId]);
  return Number(row.total);
}

export async function joinFreeCampaign({telegramUserId,campaignId}){
  const c=await pool.getConnection();
  try{
    await c.beginTransaction();
    const [[campaign]]=await c.execute("SELECT id,title,status,participation_type,starts_at,ends_at,capacity,codes_per_entry,(starts_at IS NOT NULL AND starts_at>UTC_TIMESTAMP()) AS not_started,(ends_at IS NOT NULL AND ends_at<=UTC_TIMESTAMP()) AS already_ended FROM campaigns WHERE id=? FOR UPDATE",[campaignId]);
    if(!campaign||campaign.status!=='open')throw new Error('این کمپین برای ثبت‌نام باز نیست.');
    const [[profile]]=await c.execute('SELECT id,telegram_user_id,telegram_username,full_name,phone,instagram_handle,status FROM participants WHERE telegram_user_id=? FOR UPDATE',[String(telegramUserId)]);
    if(!profile||profile.status!=='active')throw new Error('حساب کاربری فعال پیدا نشد.');
    if(Number(campaign.not_started)===1)throw new Error('زمان شروع این کمپین نرسیده است.');
    if(Number(campaign.already_ended)===1)throw new Error('مهلت این کمپین تمام شده است.');
    const [[existing]]=await c.execute('SELECT id,status FROM campaign_entries WHERE campaign_id=? AND participant_id=? FOR UPDATE',[campaignId,profile.id]);
    if(campaign.participation_type!=='free')throw new Error('این کمپین پولی است؛ برای شرکت باید سفارش پرداختی ثبت شود.');
    const target=normalizeRequestedCodeCount(campaign.codes_per_entry);
    if(existing){
      const [existingCodes]=await c.execute('SELECT code,status FROM campaign_codes WHERE campaign_entry_id=? ORDER BY id',[existing.id]);
      if(existing.status!=='eligible')throw new Error('وضعیت شرکت شما در این کمپین قابل صدور کد نیست.');
      if(existingCodes.some(code=>code.status!=='active'))throw new Error('حداقل یکی از کدهای قبلی شما غیرفعال شده است؛ برای بررسی با پشتیبانی تماس بگیرید.');
      if(existingCodes.length>=target){await c.commit();return {entryId:existing.id,codes:existingCodes.map(x=>x.code),alreadyJoined:true,status:existing.status};}
      const missing=target-existingCodes.length;
      if(campaign.capacity!==null){
        const used=await getIssuedCodeCount(c,campaignId);
        if(used+missing>Number(campaign.capacity))throw new Error('ظرفیت باقی‌مانده کمپین برای تکمیل کدهای شما کافی نیست.');
      }
      const repaired=await issueCampaignCodes(c,existing.id,campaignId,missing);
      const allCodes=[...existingCodes.map(x=>x.code),...repaired];
      await c.commit();
      return {entryId:existing.id,codes:allCodes,alreadyJoined:true,status:existing.status,repaired:true};
    }
    if(campaign.capacity!==null){
      const used=await getIssuedCodeCount(c,campaignId);
      if(used+target>Number(campaign.capacity))throw new Error('ظرفیت باقی‌مانده کمپین برای این تعداد کد کافی نیست. ظرفیت بر اساس تعداد کد محاسبه می‌شود.');
    }
    const snapshot={telegram_user_id:String(profile.telegram_user_id),telegram_username:profile.telegram_username,full_name:profile.full_name,phone:profile.phone,instagram_handle:profile.instagram_handle};
    const [insert]=await c.execute("INSERT INTO campaign_entries(campaign_id,participant_id,profile_snapshot,status) VALUES(?,?,?,'eligible')",[campaignId,profile.id,JSON.stringify(snapshot)]);
    const codes=await issueCampaignCodes(c,insert.insertId,campaignId,target);
    await c.commit();
    return {entryId:insert.insertId,codes,alreadyJoined:false,status:'eligible'};
  }catch(error){
    await c.rollback();
    if(error.code==='ER_DUP_ENTRY'){
      const [rows]=await pool.execute("SELECT e.id,e.status,cc.code FROM campaign_entries e LEFT JOIN campaign_codes cc ON cc.campaign_entry_id=e.id AND cc.status='active' JOIN participants p ON p.id=e.participant_id WHERE e.campaign_id=? AND p.telegram_user_id=? AND e.status='eligible' ORDER BY cc.id",[campaignId,String(telegramUserId)]);
      if(rows.length)return {entryId:rows[0].id,codes:rows.map(x=>x.code).filter(Boolean),alreadyJoined:true,status:rows[0].status};
    }
    throw error;
  }finally{c.release();}
}
