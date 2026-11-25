export function isOlderAdminWizardReplay(ctx,wizard){
  const updateId=Number(ctx?.update?.update_id);
  const lastUpdateId=wizard?.lastUpdateId;
  return Boolean(
    ctx?.state?.durableReplay&&
    Number.isSafeInteger(updateId)&&
    Number.isSafeInteger(lastUpdateId)&&
    updateId<=lastUpdateId
  );
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
