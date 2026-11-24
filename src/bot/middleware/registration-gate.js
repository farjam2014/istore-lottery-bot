const callbacks=new Set(['registration:start','registration:cancel','privacy:accept']);
const commands=new Set(['/start','/cancel','/admin']);
export function isRegistrationUpdateAllowed({callbackData,command,session,message}={}){
  if(callbackData&&callbacks.has(callbackData))return true;
  if(command&&commands.has(command))return true;
  if(!session)return false;
  if(message?.text)return true;
  return Boolean(message?.contact&&session.step==='awaiting_phone');
}
