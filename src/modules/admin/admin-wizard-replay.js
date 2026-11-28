export function isOlderAdminWizardReplay(ctx,wizard){
  const updateId=Number(ctx?.update?.update_id);
  const lastUpdateId=wizard?.lastUpdateId;
  return !Number.isSafeInteger(updateId)||!Number.isSafeInteger(lastUpdateId)||updateId<=lastUpdateId;
}

export function isExpiredAdminWizardSession(updatedAt,now=Date.now(),ttlMs=24*60*60*1000){
  const updated=updatedAt instanceof Date?updatedAt.getTime():Date.parse(updatedAt);
  return !Number.isFinite(updated)||!Number.isFinite(now)||!Number.isFinite(ttlMs)||ttlMs<=0||now-updated>=ttlMs;
}

export function isStaleAdminReplyUpdate(updateId,lastUpdateId){
  if(lastUpdateId===null||lastUpdateId===undefined||lastUpdateId==='')return true;
  const current=Number(updateId),last=Number(lastUpdateId);
  return !Number.isSafeInteger(current)||!Number.isSafeInteger(last)||current<=last;
}

export async function advanceAdminWizard({execute,telegramUserId,expectedStep,expectedLastUpdateId,step,payload,updateId}={}){
  if(typeof execute!=='function')throw new TypeError('A database execute function is required for admin wizard advancement.');
  const id=String(telegramUserId??'').trim();
  const cursor=Number(updateId),expectedCursor=Number(expectedLastUpdateId);
  if(!/^\d+$/.test(id))throw new TypeError('Admin Telegram user ID must be numeric.');
  if(typeof expectedStep!=='string'||!expectedStep)throw new TypeError('Expected admin wizard step is required.');
  if(!Number.isSafeInteger(cursor)||!Number.isSafeInteger(expectedCursor)||cursor<=expectedCursor)throw new TypeError('Admin wizard update cursor must be newer than the persisted cursor.');
  if(typeof step!=='string'||!step)throw new TypeError('Next admin wizard step is required.');
  const [result]=await execute('UPDATE admin_wizards SET step=?,payload=?,last_update_id=?,updated_at=UTC_TIMESTAMP() WHERE telegram_user_id=? AND step=? AND last_update_id=? AND last_update_id<?',[step,JSON.stringify(payload??{}),cursor,id,expectedStep,expectedCursor,cursor]);
  if(Number(result?.affectedRows)!==1)throw new Error('مرحله مدیریت تغییر کرده یا این پیام قبلاً پردازش شده است؛ پنل را دوباره باز کنید.');
  return true;
}
