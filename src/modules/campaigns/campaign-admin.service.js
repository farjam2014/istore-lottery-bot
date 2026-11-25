import {randomBytes} from 'node:crypto';
import {pool} from '../../database/pool.js';
import {getCorrelationId} from '../../shared/request-context.js';
import {parseUtcDateTime} from '../../shared/datetime.js';
import {isExpiredAdminWizardSession} from '../admin/admin-wizard-replay.js';

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

function makeCampaignSlug(title){
  const suffix=randomBytes(3).toString('hex');
  const base=String(title).toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g,'-').replace(/^-|-$/g,'').slice(0,55)||'campaign';
  return `${base}-${suffix}`;
}

function validateCampaignWizardPayload(payload){
  if(!payload||!['free','paid'].includes(payload.type))throw new Error('نوع کمپین در فرایند ساخت معتبر نیست.');
  const title=String(payload.title??'').trim();
  if(title.length<3||title.length>180)throw new Error('عنوان کمپین معتبر نیست.');
  const codes=Number(payload.codes);
  if(!Number.isSafeInteger(codes)||codes<1||codes>100)throw new Error('تعداد کد کمپین باید بین ۱ تا ۱۰۰ باشد.');
  const capacity=payload.capacity===null||payload.capacity===undefined?null:Number(payload.capacity);
  if(capacity!==null&&(!Number.isSafeInteger(capacity)||capacity<1||capacity>10000000))throw new Error('ظرفیت کمپین معتبر نیست.');
  const price=payload.type==='paid'?Number(payload.price):0;
  if(payload.type==='paid'&&(!Number.isSafeInteger(price)||price<1||price>1000000000000))throw new Error('قیمت کمپین معتبر نیست.');
  const description=String(payload.description||'');
  const prizeTitle=String(payload.prizeTitle||'')||null;
  const prizeDescription=String(payload.prizeDescription||'')||null;
  const terms=String(payload.terms||'')||null;
  if(description.length>3000||prizeTitle?.length>180||prizeDescription?.length>2000||terms?.length>8000)throw new Error('طول یکی از فیلدهای کمپین از حد مجاز بیشتر است.');
  const posterFileId=payload.posterFileId?String(payload.posterFileId):null;
  if(posterFileId&&posterFileId.length>255)throw new Error('شناسه پوستر کمپین معتبر نیست.');
  const rawPrizeValue=payload.prizeValue===null||payload.prizeValue===undefined?null:Number(payload.prizeValue);
  if(rawPrizeValue!==null&&(!Number.isSafeInteger(rawPrizeValue)||rawPrizeValue<0||rawPrizeValue>100000000000000))throw new Error('ارزش جایزه کمپین معتبر نیست.');
  const startsAt=payload.starts_at||null,endsAt=payload.ends_at||null,drawAt=payload.draw_at||null;
  const startsDate=startsAt?parseUtcDateTime(startsAt):null;
  const endsDate=endsAt?parseUtcDateTime(endsAt):null;
  const drawDate=drawAt?parseUtcDateTime(drawAt):null;
  if(startsDate&&endsDate&&startsDate.getTime()>=endsDate.getTime())throw new Error('زمان پایان باید بعد از شروع باشد.');
  if(drawDate&&endsDate&&drawDate.getTime()<endsDate.getTime())throw new Error('زمان قرعه‌کشی نباید قبل از پایان کمپین باشد.');
  return {title,description,posterFileId,
    prizeTitle,prizeDescription,
    prizeValue:rawPrizeValue,
    type:payload.type,price,paymentMethods:payload.type==='paid'?['card_transfer']:[],
    startsAt,endsAt,drawAt,terms,capacity,codes};
}

export async function createCampaignFromWizard({telegramUserId,actorId,database=pool}={}){
  if(!/^\d+$/.test(String(telegramUserId??''))||!/^\d+$/.test(String(actorId??'')))throw new TypeError('Campaign creator must be a numeric Telegram user ID.');
  const connection=await database.getConnection();
  try{
    await connection.beginTransaction();
    const [[wizard]]=await connection.execute('SELECT step,payload,updated_at FROM admin_wizards WHERE telegram_user_id=? FOR UPDATE',[String(telegramUserId)]);
    if(!wizard||wizard.step!=='confirm'||isExpiredAdminWizardSession(wizard.updated_at))throw new Error('فرایند ساخت کمپین منقضی شده است.');
    const payload=typeof wizard.payload==='string'?JSON.parse(wizard.payload):wizard.payload;
    const value=validateCampaignWizardPayload(payload);
    const [created]=await connection.execute(
      "INSERT INTO campaigns(slug,title,description,poster_file_id,prize_title,prize_description,prize_value,status,participation_type,entry_price,payment_methods,starts_at,ends_at,draw_at,terms,capacity,codes_per_entry) VALUES(?,?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?)",
      [makeCampaignSlug(value.title),value.title,value.description,value.posterFileId,value.prizeTitle,value.prizeDescription,value.prizeValue,value.type,value.price,JSON.stringify(value.paymentMethods),value.startsAt,value.endsAt,value.drawAt,value.terms,value.capacity,value.codes]
    );
    await connection.execute(
      'INSERT INTO admin_audit_log(admin_telegram_id,correlation_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)',
      [String(actorId),getCorrelationId(),'campaign.created','campaign',created.insertId,JSON.stringify({type:value.type,title:value.title})]
    );
    await connection.execute('DELETE FROM admin_wizards WHERE telegram_user_id=?',[String(telegramUserId)]);
    await connection.commit();
    return {campaignId:created.insertId,title:value.title};
  }catch(error){await connection.rollback();throw error;}
  finally{connection.release();}
}

export async function copyCampaign({campaignId,actorId,idempotencyKey,database=pool}={}){
  const id=Number(campaignId);
  if(!Number.isSafeInteger(id)||id<1)throw new TypeError('Campaign ID must be a positive safe integer.');
  if(!/^\d+$/.test(String(actorId??'')))throw new TypeError('Campaign actor must be a numeric Telegram user ID.');
  const key=String(idempotencyKey??'');
  if(!/^[a-f0-9]{64}$/i.test(key))throw new TypeError('Campaign copy idempotency key is invalid.');
  const connection=await database.getConnection();
  try{
    await connection.beginTransaction();
    const [claim]=await connection.execute("INSERT IGNORE INTO admin_action_idempotency(idempotency_key,action_type,actor_telegram_id) VALUES(?,'campaign.copy',?)",[key,String(actorId)]);
    const [[request]]=await connection.execute('SELECT action_type,actor_telegram_id,entity_id FROM admin_action_idempotency WHERE idempotency_key=? FOR UPDATE',[key]);
    if(!request||request.action_type!=='campaign.copy'||String(request.actor_telegram_id)!==String(actorId))throw new Error('درخواست تکراری کپی کمپین معتبر نیست.');
    if(request.entity_id!==null&&request.entity_id!==undefined){
      await connection.commit();
      return {campaignId:Number(request.entity_id),alreadyProcessed:true};
    }
    if(Number(claim?.affectedRows)!==1)throw new Error('درخواست قبلی کپی کمپین وضعیت ناقص دارد؛ برای جلوگیری از ایجاد نسخه تکراری، عملیات متوقف شد.');
    const [[source]]=await connection.execute('SELECT * FROM campaigns WHERE id=? FOR UPDATE',[id]);
    if(!source)throw new Error('کمپین پیدا نشد.');
    const copySuffix=' (نسخه کپی)';
    const title=String(source.title||'').slice(0,180-copySuffix.length)+copySuffix;
    const [created]=await connection.execute(
      "INSERT INTO campaigns(slug,title,description,poster_file_id,prize_title,prize_description,prize_value,status,participation_type,entry_price,payment_methods,starts_at,ends_at,draw_at,terms,capacity,codes_per_entry) VALUES(?,?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?)",
      [makeCampaignSlug(String(source.title||'')+'-copy'),title,source.description,source.poster_file_id,source.prize_title,source.prize_description,source.prize_value,source.participation_type,source.entry_price,typeof source.payment_methods==='string'?source.payment_methods:JSON.stringify(source.payment_methods||[]),source.starts_at,source.ends_at,source.draw_at,source.terms,source.capacity,source.codes_per_entry]
    );
    await connection.execute(
      'INSERT INTO admin_audit_log(admin_telegram_id,correlation_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)',
      [String(actorId),getCorrelationId(),'campaign.copied','campaign',created.insertId,JSON.stringify({sourceCampaignId:id})]
    );
    await connection.execute('UPDATE admin_action_idempotency SET entity_id=? WHERE idempotency_key=? AND entity_id IS NULL',[created.insertId,key]);
    await connection.commit();
    return {campaignId:created.insertId,title,alreadyProcessed:false};
  }catch(error){await connection.rollback();throw error;}
  finally{connection.release();}
}
