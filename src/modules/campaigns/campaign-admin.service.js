import {randomBytes} from 'node:crypto';
import {pool} from '../../database/pool.js';
import {getCorrelationId} from '../../shared/request-context.js';
import {parseUtcDateTime} from '../../shared/datetime.js';

function slugify(title){
  const suffix=randomBytes(3).toString('hex');
  const base=String(title).toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g,'-').replace(/^-|-$/g,'').slice(0,55)||'campaign';
  return `${base}-${suffix}`;
}
function validatePayload(payload){
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('اطلاعات کمپین معتبر نیست.');
  if(!['free','paid'].includes(payload.type))throw new Error('نوع کمپین معتبر نیست.');
  const title=String(payload.title??'').trim();
  if(title.length<3||title.length>180)throw new Error('عنوان کمپین باید بین ۳ تا ۱۸۰ نویسه باشد.');
  const description=String(payload.description??'');
  if(description.length>3000)throw new Error('توضیح کمپین بیش از حد مجاز است.');
  const prizeTitle=String(payload.prizeTitle||'').trim()||null;
  const prizeDescription=String(payload.prizeDescription||'').trim()||null;
  const terms=String(payload.terms||'').trim()||null;
  const posterFileId=payload.posterFileId==null?null:String(payload.posterFileId);
  if(prizeTitle&&prizeTitle.length>180)throw new Error('نام جایزه بیش از حد مجاز است.');
  if(prizeDescription&&prizeDescription.length>2000)throw new Error('توضیح جایزه بیش از حد مجاز است.');
  if(terms&&terms.length>8000)throw new Error('قوانین کمپین بیش از حد مجاز است.');
  if(posterFileId&&posterFileId.length>255)throw new Error('شناسه پوستر معتبر نیست.');
  const capacity=payload.capacity==null?null:Number(payload.capacity);
  const codes=Number(payload.codes);
  const price=payload.type==='paid'?Number(payload.price):0;
  if(capacity!==null&&(!Number.isSafeInteger(capacity)||capacity<1||capacity>10000000))throw new Error('ظرفیت کمپین معتبر نیست.');
  if(!Number.isSafeInteger(codes)||codes<1||codes>100)throw new Error('تعداد کد برای هر نفر معتبر نیست.');
  if(payload.type==='paid'&&(!Number.isSafeInteger(price)||price<1||price>1000000000000))throw new Error('مبلغ شرکت در کمپین معتبر نیست.');
  const startsAt=payload.starts_at||null,endsAt=payload.ends_at||null,drawAt=payload.draw_at||null;
  if(startsAt)parseUtcDateTime(startsAt);
  if(endsAt)parseUtcDateTime(endsAt);
  if(drawAt)parseUtcDateTime(drawAt);
  if(startsAt&&endsAt&&parseUtcDateTime(startsAt).getTime()>=parseUtcDateTime(endsAt).getTime())throw new Error('زمان پایان باید بعد از شروع باشد.');
  if(drawAt&&endsAt&&parseUtcDateTime(drawAt).getTime()<parseUtcDateTime(endsAt).getTime())throw new Error('زمان قرعه‌کشی نباید قبل از پایان کمپین باشد.');
  const prizeValue=payload.prizeValue==null?null:Number(payload.prizeValue);
  if(prizeValue!==null&&(!Number.isSafeInteger(prizeValue)||prizeValue<0||prizeValue>100000000000000))throw new Error('ارزش جایزه معتبر نیست.');
  return {
    title,description,
    posterFileId,
    prizeTitle,
    prizeDescription,
    prizeValue,
    type:payload.type,
    price,
    paymentMethods:payload.type==='paid'?['card_transfer']:[],
    startsAt,endsAt,drawAt,
    terms,
    capacity,codes
  };
}

export async function createCampaignFromWizard({adminId}){
  const actor=String(adminId??'');
  if(!/^\d+$/.test(actor))throw new Error('شناسه مدیر معتبر نیست.');
  const c=await pool.getConnection();
  try{
    await c.beginTransaction();
    const [[wizard]]=await c.execute('SELECT step,payload FROM admin_wizards WHERE telegram_user_id=? FOR UPDATE',[actor]);
    if(!wizard||wizard.step!=='confirm')throw new Error('فرایند ساخت کمپین منقضی شده است.');
    const payload=typeof wizard.payload==='string'?JSON.parse(wizard.payload):wizard.payload;
    const p=validatePayload(payload);
    const slug=slugify(p.title);
    const [created]=await c.execute(
      "INSERT INTO campaigns(slug,title,description,poster_file_id,prize_title,prize_description,prize_value,status,participation_type,entry_price,payment_methods,starts_at,ends_at,draw_at,terms,capacity,codes_per_entry) VALUES(?,?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?)",
      [slug,p.title,p.description,p.posterFileId,p.prizeTitle,p.prizeDescription,p.prizeValue,p.type,p.price,JSON.stringify(p.paymentMethods),p.startsAt,p.endsAt,p.drawAt,p.terms,p.capacity,p.codes]
    );
    await c.execute(
      'INSERT INTO admin_audit_log(admin_telegram_id,correlation_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)',
      [actor,getCorrelationId(),'campaign.created','campaign',created.insertId,JSON.stringify({type:p.type,title:p.title})]
    );
    const [removed]=await c.execute('DELETE FROM admin_wizards WHERE telegram_user_id=? AND step=\'confirm\'',[actor]);
    if(Number(removed.affectedRows)!==1)throw new Error('نشست ساخت کمپین هم‌زمان تغییر کرده است؛ دوباره بررسی کنید.');
    await c.commit();
    return {id:created.insertId,title:p.title};
  }catch(error){
    try{await c.rollback();}catch{}
    throw error;
  }finally{
    c.release();
  }
}
