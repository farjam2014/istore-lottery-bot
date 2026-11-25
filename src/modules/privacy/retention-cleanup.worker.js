import {pool} from '../../database/pool.js';

const RETENTION_DELETE_STATEMENTS=[
  ['registration_sessions',"DELETE FROM telegram_user_sessions WHERE updated_at<UTC_TIMESTAMP()-INTERVAL 24 HOUR LIMIT 500"],
  ['admin_wizards',"DELETE FROM admin_wizards WHERE updated_at<UTC_TIMESTAMP()-INTERVAL 24 HOUR LIMIT 500"],
  ['payment_card_admin_sessions',"DELETE FROM payment_card_admin_sessions WHERE updated_at<UTC_TIMESTAMP()-INTERVAL 24 HOUR LIMIT 500"],
  ['payment_admin_sessions',"DELETE FROM payment_admin_sessions WHERE created_at<UTC_TIMESTAMP()-INTERVAL 24 HOUR LIMIT 500"],
  ['admin_search_sessions',"DELETE FROM admin_search_sessions WHERE created_at<UTC_TIMESTAMP()-INTERVAL 24 HOUR LIMIT 500"],
  ['admin_role_sessions',"DELETE FROM admin_role_sessions WHERE created_at<UTC_TIMESTAMP()-INTERVAL 24 HOUR LIMIT 500"],
  ['support_sessions',"DELETE FROM support_sessions WHERE updated_at<UTC_TIMESTAMP()-INTERVAL 24 HOUR LIMIT 500"],
  ['profile_change_sessions',"DELETE FROM profile_change_sessions WHERE created_at<UTC_TIMESTAMP()-INTERVAL 24 HOUR LIMIT 500"],
  ['processed_updates',"DELETE FROM processed_updates WHERE processed_at<UTC_TIMESTAMP()-INTERVAL 3 DAY LIMIT 500"],
  ['telegram_rate_limits',"DELETE FROM telegram_rate_limits WHERE window_started_at<UTC_TIMESTAMP()-INTERVAL 1 DAY LIMIT 500"]
];

export function createRetentionCleanupWorker({database=pool}={}){
  return async function cleanupExpiredRetentionRows(){
    const byTable={};let deleted=0;
    for(const [table,sql] of RETENTION_DELETE_STATEMENTS){
      const [result]=await database.execute(sql);
      const count=Math.max(0,Number(result?.affectedRows)||0);
      byTable[table]=count;deleted+=count;
    }
    return {deleted,byTable};
  };
}

export async function cleanupExpiredRetentionRows(){
  return createRetentionCleanupWorker()();
}
