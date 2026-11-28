import {pool} from '../../database/pool.js';

const ADMIN_TEXT_SESSIONS=[
  ['admin_wizards','DELETE FROM admin_wizards WHERE telegram_user_id=?'],
  ['payment_card_admin_sessions','DELETE FROM payment_card_admin_sessions WHERE telegram_user_id=?'],
  ['payment_admin_sessions','DELETE FROM payment_admin_sessions WHERE telegram_user_id=?'],
  ['admin_search_sessions','DELETE FROM admin_search_sessions WHERE telegram_user_id=?'],
  ['admin_role_sessions','DELETE FROM admin_role_sessions WHERE telegram_user_id=?'],
  ['support_sessions',"DELETE FROM support_sessions WHERE telegram_user_id=? AND step='admin_reply'"]
];

export async function clearAdminTextSessions({telegramUserId,keep=null,executor=pool}={}){
  const id=String(telegramUserId??'').trim();
  if(!id)throw new TypeError('Telegram user ID is required to clear admin text sessions.');
  if(keep!==null&&!ADMIN_TEXT_SESSIONS.some(([name])=>name===keep))throw new TypeError('Unknown admin text session type: '+keep);

  // Use one transaction when called with the shared pool. Callers that pass an
  // existing transaction connection retain ownership of its commit/rollback.
  const ownsConnection=typeof executor.getConnection==='function';
  const connection=ownsConnection?await executor.getConnection():executor;
  let transactionStarted=false;
  try{
    if(ownsConnection){await connection.beginTransaction();transactionStarted=true;}
    for(const [name,sql] of ADMIN_TEXT_SESSIONS){
      if(name===keep)continue;
      await connection.execute(sql,[id]);
    }
    if(transactionStarted){await connection.commit();transactionStarted=false;}
  }catch(error){
    if(transactionStarted){try{await connection.rollback();}catch{}}
    throw error;
  }finally{
    if(ownsConnection)connection.release();
  }
}
