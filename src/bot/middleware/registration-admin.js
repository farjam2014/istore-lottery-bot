export async function shouldBypassRegistration({telegramId,configuredAdminIds,hasDashboardPermission}){
  const id=String(telegramId??'');
  if(!id)return false;
  if(configuredAdminIds?.has(id))return true;
  return Boolean(await hasDashboardPermission(id));
}
