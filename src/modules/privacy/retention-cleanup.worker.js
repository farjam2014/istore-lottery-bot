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

const RETENTION_REDACT_STATEMENTS=[
  ['telegram_update_inbox',"UPDATE telegram_update_inbox SET last_error='legacy_error_redacted' WHERE last_error IS NOT NULL AND last_error NOT IN ('handler_failed','invalid_payload','payload_update_id_mismatch','legacy_error_redacted') LIMIT 500"],
  ['telegram_notification_outbox',"UPDATE telegram_notification_outbox SET last_error='legacy_error_redacted' WHERE last_error IS NOT NULL AND last_error NOT IN ('invalid_payload','telegram_http_429','telegram_http_4xx','telegram_http_5xx','telegram_http_408_timeout','network_or_unknown','manually_requeued','legacy_error_redacted') LIMIT 500"]
];

export function createRetentionCleanupWorker({database=pool}={}){
  return async function cleanupExpiredRetentionRows(){
    const byTable={},redactedByTable={};let deleted=0,redacted=0;
    for(const [table,sql] of RETENTION_DELETE_STATEMENTS){
      const [result]=await database.execute(sql);
      const count=Math.max(0,Number(result?.affectedRows)||0);
      byTable[table]=count;deleted+=count;
    }
    for(const [table,sql] of RETENTION_REDACT_STATEMENTS){
      const [result]=await database.execute(sql);
      const count=Math.max(0,Number(result?.affectedRows)||0);
      redactedByTable[table]=count;redacted+=count;
    }
    return {deleted,byTable,redacted,redactedByTable};
  };
}

export async function cleanupExpiredRetentionRows(){
  return createRetentionCleanupWorker()();
}
