export async function lockSupportSession(connection,{telegramUserId,step,ticketId=null}){
  const [[session]]=await connection.execute(
    'SELECT step,ticket_id,category FROM support_sessions WHERE telegram_user_id=? FOR UPDATE',
    [String(telegramUserId)]
  );
  if(!session||session.step!==step)return null;
  if(ticketId!==null&&String(session.ticket_id)!==String(ticketId))return null;
  return session;
}
