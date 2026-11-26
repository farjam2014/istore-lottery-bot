import {pool} from '../../database/pool.js';
import {getCorrelationId} from '../../shared/request-context.js';

export async function retryOutboxNotification({notificationId,adminId,expectedStatus,database=pool}={}){
  const id=Number(notificationId);
  if(!Number.isSafeInteger(id)||id<1)throw new TypeError('Notification ID must be a positive safe integer.');
  if(!/^\d+$/.test(String(adminId??'')))throw new TypeError('Admin ID must be numeric.');
  if(!['failed','uncertain'].includes(expectedStatus))throw new TypeError('Only failed or uncertain notifications may be manually retried.');
  const connection=await database.getConnection();
  try{
    await connection.beginTransaction();
    const [[row]]=await connection.execute('SELECT id,status,attempts,manual_retry_count FROM telegram_notification_outbox WHERE id=? FOR UPDATE',[id]);
    if(!row)throw new Error('اعلان موردنظر پیدا نشد.');
    if(row.status!==expectedStatus)throw new Error('وضعیت اعلان از زمان نمایش تغییر کرده است؛ فهرست را دوباره باز کنید.');
    await connection.execute(
      "UPDATE telegram_notification_outbox SET status='pending',attempts=0,manual_retry_count=manual_retry_count+1,available_at=UTC_TIMESTAMP(),locked_at=NULL,lease_token=NULL,last_error='manually_requeued' WHERE id=? AND status=?",
      [id,expectedStatus]
    );
    await connection.execute(
      'INSERT INTO admin_audit_log(admin_telegram_id,correlation_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)',
      [String(adminId),getCorrelationId(),'system.outbox_manual_retry','notification_outbox',id,JSON.stringify({previousStatus:expectedStatus,attempts:Number(row.attempts||0),manualRetryCount:Number(row.manual_retry_count||0)+1})]
    );
    await connection.commit();
    return {notificationId:id,previousStatus:expectedStatus};
  }catch(error){await connection.rollback();throw error;}
  finally{connection.release();}
}
