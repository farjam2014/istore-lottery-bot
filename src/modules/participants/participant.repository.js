import {pool} from '../../database/pool.js';
export async function findByTelegramId(id){const [r]=await pool.execute('SELECT id,telegram_user_id,telegram_username,full_name,phone,instagram_handle,status,privacy_consent_version,privacy_consent_at,created_at FROM participants WHERE telegram_user_id=? LIMIT 1',[String(id)]);return r[0]??null;}
export async function saveSession(id,step,payload,lastUpdateId){if(!Number.isSafeInteger(Number(lastUpdateId)))throw new TypeError('Telegram update ID is required to create a registration session.');const cursor=Number(lastUpdateId);await pool.execute('INSERT INTO telegram_user_sessions(telegram_user_id,step,payload,last_update_id) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE step=IF(VALUES(last_update_id)>COALESCE(last_update_id,-1),VALUES(step),step),payload=IF(VALUES(last_update_id)>COALESCE(last_update_id,-1),VALUES(payload),payload),updated_at=IF(VALUES(last_update_id)>COALESCE(last_update_id,-1),CURRENT_TIMESTAMP,updated_at),last_update_id=GREATEST(COALESCE(last_update_id,-1),VALUES(last_update_id))',[String(id),step,JSON.stringify(payload),cursor]);}
export async function advanceSession(id,expectedStep,step,payload,updateId){if(!Number.isSafeInteger(Number(updateId)))throw new TypeError('Telegram update ID is required for session advancement.');const cursor=Number(updateId);const [result]=await pool.execute('UPDATE telegram_user_sessions SET step=?,payload=?,last_update_id=?,updated_at=CURRENT_TIMESTAMP WHERE telegram_user_id=? AND step=? AND last_update_id IS NOT NULL AND last_update_id<?',[step,JSON.stringify(payload),cursor,String(id),expectedStep,cursor]);if(!result.affectedRows)throw new Error('مرحله ثبت‌نام تغییر کرده یا این پیام قدیمی/تکراری است؛ لطفاً مرحله فعلی را دوباره باز کنید.');}
export async function getSession(id){const [r]=await pool.execute('SELECT step,payload,last_update_id FROM telegram_user_sessions WHERE telegram_user_id=?',[String(id)]);if(!r[0])return null;return {step:r[0].step,payload:typeof r[0].payload==='string'?JSON.parse(r[0].payload):r[0].payload,lastUpdateId:r[0].last_update_id===null?null:Number(r[0].last_update_id)};}
export async function clearSession(id,expectedLastUpdateId){
  if(expectedLastUpdateId===undefined){await pool.execute('DELETE FROM telegram_user_sessions WHERE telegram_user_id=?',[String(id)]);return true;}
  if(!Number.isSafeInteger(Number(expectedLastUpdateId)))return false;
  const [result]=await pool.execute('DELETE FROM telegram_user_sessions WHERE telegram_user_id=? AND last_update_id=?',[String(id),Number(expectedLastUpdateId)]);
  return Number(result?.affectedRows)===1;
}
export async function clearSessionIfNewer(id,updateId){
  if(!Number.isSafeInteger(Number(updateId)))return false;
  const [result]=await pool.execute('DELETE FROM telegram_user_sessions WHERE telegram_user_id=? AND last_update_id IS NOT NULL AND last_update_id<?',[String(id),Number(updateId)]);
  return Number(result?.affectedRows)===1;
}
export async function updatePrivacyConsent(telegramUserId,version){await pool.execute('UPDATE participants SET privacy_consent_version=?,privacy_consent_at=IF(privacy_consent_version<=>?,privacy_consent_at,UTC_TIMESTAMP()) WHERE telegram_user_id=?',[String(version),String(version),String(telegramUserId)]);}
export async function createProfile({telegramUserId,username,fullName,phone,instagramHandle,privacyConsentVersion,privacyConsentAt}){if(!/^[A-Za-z0-9._-]{1,40}$/.test(String(privacyConsentVersion??'')))throw new Error('تأیید اطلاعیه حریم خصوصی الزامی است.');const acceptedAt=privacyConsentAt instanceof Date?privacyConsentAt:new Date(privacyConsentAt);if(!Number.isFinite(acceptedAt.getTime()))throw new Error('زمان تأیید اطلاعیه حریم خصوصی معتبر نیست.');const c=await pool.getConnection();try{await c.beginTransaction();await c.execute('INSERT INTO participants(telegram_user_id,telegram_username,full_name,phone,instagram_handle,privacy_consent_version,privacy_consent_at) VALUES(?,?,?,?,?,?,?)',[String(telegramUserId),username||null,fullName,phone,instagramHandle,String(privacyConsentVersion),acceptedAt]);await c.execute('DELETE FROM telegram_user_sessions WHERE telegram_user_id=?',[String(telegramUserId)]);const [r]=await c.execute('SELECT id,telegram_user_id,telegram_username,full_name,phone,instagram_handle,status,privacy_consent_version,privacy_consent_at,created_at FROM participants WHERE telegram_user_id=?',[String(telegramUserId)]);await c.commit();return r[0];}catch(e){await c.rollback();if(e.code==='ER_DUP_ENTRY'){const [r]=await c.execute('SELECT id,telegram_user_id,telegram_username,full_name,phone,instagram_handle,status,privacy_consent_version,privacy_consent_at,created_at FROM participants WHERE telegram_user_id=?',[String(telegramUserId)]);if(r[0]){await c.execute('UPDATE participants SET privacy_consent_version=?,privacy_consent_at=IF(privacy_consent_version<=>?,privacy_consent_at,?) WHERE telegram_user_id=?',[String(privacyConsentVersion),String(privacyConsentVersion),acceptedAt,String(telegramUserId)]);const [updated]=await c.execute('SELECT id,telegram_user_id,telegram_username,full_name,phone,instagram_handle,status,privacy_consent_version,privacy_consent_at,created_at FROM participants WHERE telegram_user_id=?',[String(telegramUserId)]);return updated[0];}throw new Error('اطلاعات ثبت‌نام با یک حساب دیگر تداخل دارد؛ با پشتیبانی تماس بگیرید.');}throw e;}finally{c.release();}}


export async function completeProfileFromSession({telegramUserId,username,fullName,phone,instagramHandle,expectedLastUpdateId,updateId}){
  const expected=Number(expectedLastUpdateId),incoming=Number(updateId),userId=String(telegramUserId);
  if(!Number.isSafeInteger(expected)||!Number.isSafeInteger(incoming)||incoming<=expected)throw new TypeError('A newer Telegram update and the expected registration cursor are required.');
  const c=await pool.getConnection();
  try{
    await c.beginTransaction();
    const [[session]]=await c.execute('SELECT step,payload,last_update_id FROM telegram_user_sessions WHERE telegram_user_id=? FOR UPDATE',[userId]);
    if(!session){
      const [existing]=await c.execute('SELECT id,telegram_user_id,telegram_username,full_name,phone,instagram_handle,status,privacy_consent_version,privacy_consent_at,created_at FROM participants WHERE telegram_user_id=?',[userId]);
      if(existing[0]){await c.commit();return existing[0];}
      throw new Error('مرحله ثبت‌نام تغییر کرده یا این پیام قدیمی/تکراری است؛ لطفاً ثبت‌نام را دوباره باز کنید.');
    }
    const cursor=session.last_update_id===null?null:Number(session.last_update_id);
    if(session.step!=='awaiting_instagram'||cursor!==expected||incoming<=cursor)throw new Error('مرحله ثبت‌نام تغییر کرده یا این پیام قدیمی/تکراری است؛ لطفاً مرحله فعلی را دوباره باز کنید.');
    const payload=typeof session.payload==='string'?JSON.parse(session.payload):session.payload;
    const consentVersion=String(payload?.privacyConsentVersion??'');
    if(!/^[A-Za-z0-9._-]{1,40}$/.test(consentVersion))throw new Error('تأیید اطلاعیه حریم خصوصی الزامی است.');
    const acceptedAt=new Date(payload?.privacyConsentAt);
    if(!Number.isFinite(acceptedAt.getTime()))throw new Error('زمان تأیید اطلاعیه حریم خصوصی معتبر نیست.');
    await c.execute('INSERT INTO participants(telegram_user_id,telegram_username,full_name,phone,instagram_handle,privacy_consent_version,privacy_consent_at) VALUES(?,?,?,?,?,?,?)',[userId,username||null,fullName,phone,instagramHandle,consentVersion,acceptedAt]);
    const [removed]=await c.execute('DELETE FROM telegram_user_sessions WHERE telegram_user_id=? AND last_update_id=?',[userId,expected]);
    if(Number(removed?.affectedRows)!==1)throw new Error('نشست ثبت‌نام هم‌زمان تغییر کرد؛ لطفاً ثبت‌نام را دوباره باز کنید.');
    const [rows]=await c.execute('SELECT id,telegram_user_id,telegram_username,full_name,phone,instagram_handle,status,privacy_consent_version,privacy_consent_at,created_at FROM participants WHERE telegram_user_id=?',[userId]);
    await c.commit();
    return rows[0];
  }catch(error){
    await c.rollback();
    if(error.code==='ER_DUP_ENTRY'){
      const [existing]=await pool.execute('SELECT id,telegram_user_id,telegram_username,full_name,phone,instagram_handle,status,privacy_consent_version,privacy_consent_at,created_at FROM participants WHERE telegram_user_id=?',[userId]);
      if(existing[0])return existing[0];
      throw new Error('اطلاعات ثبت‌نام با یک حساب دیگر تداخل دارد؛ با پشتیبانی تماس بگیرید.');
    }
    throw error;
  }finally{c.release();}
}
