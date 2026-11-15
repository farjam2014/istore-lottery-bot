import {randomInt} from 'node:crypto';
import {pool} from '../../database/pool.js';
const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode(){let value='';for(let i=0;i<8;i++)value+=alphabet[randomInt(alphabet.length)];return 'IST-'+value;}

export async function joinFreeCampaign({telegramUserId,campaignId}){
  const c=await pool.getConnection();
  try{
    await c.beginTransaction();
    const [[campaign]]=await c.execute("SELECT id,title,status,participation_type,starts_at,ends_at,capacity,codes_per_entry,(starts_at IS NOT NULL AND starts_at>UTC_TIMESTAMP()) AS not_started,(ends_at IS NOT NULL AND ends_at<UTC_TIMESTAMP()) AS already_ended WHERE id=? FOR UPDATE",[campaignId]);
    if(!campaign||campaign.status!=='open')throw new Error('این کمپین برای ثبت‌نام باز نیست.');
    const [[profile]]=await c.execute('SELECT id,telegram_user_id,telegram_username,full_name,phone,instagram_handle,status FROM participants WHERE telegram_user_id=? FOR UPDATE',[String(telegramUserId)]);
    if(!profile||profile.status!=='active')throw new Error('حساب کاربری فعال پیدا نشد.');
    if(Number(campaign.not_started)===1)throw new Error('زمان شروع این کمپین نرسیده است.');
    if(Number(campaign.already_ended)===1)throw new Error('مهلت این کمپین تمام شده است.');
    const [[existing]]=await c.execute('SELECT id,status FROM campaign_entries WHERE campaign_id=? AND participant_id=? FOR UPDATE',[campaignId,profile.id]);
    if(campaign.participation_type!=='free')throw new Error('این کمپین پولی است؛ برای شرکت باید سفارش پرداختی ثبت شود.');
    if(existing){
      const [existingCodes]=await c.execute('SELECT code FROM campaign_codes WHERE campaign_entry_id=? ORDER BY id',[existing.id]);
      if(existing.status!=='eligible')throw new Error('وضعیت شرکت شما در این کمپین قابل صدور کد نیست.');
      if(existingCodes.length){await c.commit();return {entryId:existing.id,codes:existingCodes.map(x=>x.code),alreadyJoined:true,status:existing.status};}
      const repaired=await issueCodes(c,existing.id,campaignId,campaign.codes_per_entry);
      await c.commit();
      return {entryId:existing.id,codes:repaired,alreadyJoined:true,status:existing.status,repaired:true};
    }
    if(campaign.capacity!==null){
      const [[count]]=await c.execute("SELECT COUNT(*) AS total FROM campaign_entries WHERE campaign_id=? AND status IN ('eligible','pending_payment')",[campaignId]);
      if(Number(count.total)>=Number(campaign.capacity))throw new Error('ظرفیت این کمپین تکمیل شده است.');
    }
    const snapshot={telegram_user_id:String(profile.telegram_user_id),telegram_username:profile.telegram_username,full_name:profile.full_name,phone:profile.phone,instagram_handle:profile.instagram_handle};
    const [insert]=await c.execute("INSERT INTO campaign_entries(campaign_id,participant_id,profile_snapshot,status) VALUES(?,?,?,'eligible')",[campaignId,profile.id,JSON.stringify(snapshot)]);
    const codes=await issueCodes(c,insert.insertId,campaignId,campaign.codes_per_entry);
    await c.commit();
    return {entryId:insert.insertId,codes,alreadyJoined:false,status:'eligible'};
  }catch(error){await c.rollback();if(error.code==='ER_DUP_ENTRY'){const [rows]=await pool.execute("SELECT e.id,e.status,cc.code FROM campaign_entries e LEFT JOIN campaign_codes cc ON cc.campaign_entry_id=e.id JOIN participants p ON p.id=e.participant_id WHERE e.campaign_id=? AND p.telegram_user_id=? ORDER BY cc.id",[campaignId,String(telegramUserId)]);if(rows.length)return {entryId:rows[0].id,codes:rows.map(x=>x.code).filter(Boolean),alreadyJoined:true,status:rows[0].status};}throw error;}
  finally{c.release();}
}
async function issueCodes(connection,entryId,campaignId,requested){
  const count=Math.max(1,Math.min(100,Number(requested)||1));
  const codes=[];
  for(let i=0;i<count;i++){
    let inserted=false;
    for(let attempt=0;attempt<10&&!inserted;attempt++){
      const code=makeCode();
      try{await connection.execute('INSERT INTO campaign_codes(campaign_entry_id,campaign_id,code) VALUES(?,?,?)',[entryId,campaignId,code]);codes.push(code);inserted=true;}
      catch(error){if(error.code!=='ER_DUP_ENTRY')throw error;}
    }
    if(!inserted)throw new Error('تولید کد یکتا ناموفق بود؛ عملیات لغو شد.');
  }
  return codes;
}
