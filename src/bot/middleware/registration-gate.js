const callbacks=new Set(['registration:start']);
const commands=new Set(['/start','/cancel','/admin']);
export function isRegistrationUpdateAllowed({callbackData,command,session,message}={}){
  if(callbackData&&(callbacks.has(callbackData)||/^(?:pa:(?:-1|[0-9]{1,16}):[A-Za-z0-9._-]{1,40}|registration:cancel:(?:-1|[0-9]{1,16}))$/.test(callbackData)))return true;
  if(command&&commands.has(command))return true;
  if(!session)return false;
  if(message?.text)return true;
  return Boolean(message?.contact&&session.step==='awaiting_phone');
}
