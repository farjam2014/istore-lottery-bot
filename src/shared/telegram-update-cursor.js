export function isStaleTelegramUpdate(updateId,lastUpdateId){
  if(lastUpdateId===null||lastUpdateId===undefined)return true;
  const incoming=Number(updateId);
  const cursor=Number(lastUpdateId);
  if(!Number.isSafeInteger(incoming)||!Number.isSafeInteger(cursor))return true;
  return incoming<=cursor;
}
