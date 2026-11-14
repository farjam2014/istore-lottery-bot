import {randomInt} from 'node:crypto';
import {pool} from '../../database/pool.js';

const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode(){let value='';for(let i=0;i<8;i++)value+=alphabet[randomInt(alphabet.length)];return 'IST-'+value;}

export async function joinFreeCampaign({telegramUserId,campaignId}){
  const c=await pool.getConnection();
  try{
    await c.beginTransaction();
    const [[campaign]]=await c.execute("SELECT id,title,status,participation_type,starts_at,ends_at,capacity,codes_per_entry FROM campaigns WHERE id=? FOR UPDATE",[campaignId]);
    if(!campaign||campaign.status!=='open')throw new Error('این کمپین برای ثبت‌نام باز نیست.');
    const [[profile]]=await c.execute('SELECT id,telegram_user_id,telegram_username,full_name,phone,instagram_handle,status FROM participants WHERE telegram_user_id=? FOR UPDATE',[String(telegramUserId)]);
    if(!profile||profile.status!=='active')throw new Error('حساب کاربری فعال پیدا نشد.');
    if(campaign.starts_at&&new Date(campaign.starts_at)>new Date())throw new Error('زمان شروع این کمپین نرسیده است.');
    if(campaign.ends_at&&new Date(campaign.ends_at)<new Date())throw new Error('مهلت این کمپین تمام شده است.');
    const [[existing]]=await c.execute('SELECT id,status FROM campaign_entries WHERE campaign_id=? AND participant_id=? FOR UPDATE',[campaignId,profile.id]);
    if(existing){
      const [codes]=await c.execute('SELECT code FROM campaign_codes WHERE campaign_entry_id=? ORDER BY id',[existing.id]);
      await c.commit();
      return {entryId:existing.id,codes:codes.map(x=>x.code),alreadyJoined:true,status:existing.status};
    }
    if(campaign.participation_type!=='free')throw new Error('این کمپین پرداختی است؛ فرایند سفارش و پرداخت هنوز فعال نشده است.');
    if(campaign.capacity!==null){
      const [[count]]=await c.execute("SELECT COUNT(*) AS total FROM campaign_entries WHERE campaign_id=? AND status IN ('eligible','pending_payment')",[campaignId]);
      if(Number(count.total)>=Number(campaign.capacity))throw new Error('ظرفیت این کمپین تکمیل شده است.');
    }
    const snapshot={telegram_user_id:String(profile.telegram_user_id),telegram_username:profile.telegram_username,full_name:profile.full_name,phone:profile.phone,instagram_handle:profile.instagram_handle};
    const [insert]=await c.execute("INSERT INTO campaign_entries(campaign_id,participant_id,profile_snapshot,status) VALUES(?,?,?,'eligible')",[campaignId,profile.id,JSON.stringify(snapshot)]);
    const entryId=insert.insertId;
    const number=Math.max(1,Math.min(100,Number(campaign.codes_per_entry)||1));
    const codes=[];
    for(let i=0;i<number;i++){
      let code,attempt=0;
      do{
        code=makeCode();
        try{await c.execute('INSERT INTO campaign_codes(campaign_entry_id,campaign_id,code) VALUES(?,?,?)',[entryId,campaignId,code]);break;}
        catch(error){if(error.code!=='ER_DUP_ENTRY'||++attempt>=5)throw error;}
      }while(true);
      codes.push(code);
    }
    await c.commit();
    return {entryId,codes,alreadyJoined:false,status:'eligible'};
  }catch(error){await c.rollback();throw error;}finally{c.release();}
}
