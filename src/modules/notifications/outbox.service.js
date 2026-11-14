import {pool} from '../../database/pool.js';

export async function enqueueTelegramNotification({chatId,text,options={}}){
  const message=String(text??'').trim();
  if(!message)throw new Error('Notification text is required.');
  await pool.execute(
    "INSERT INTO telegram_notification_outbox(chat_id,payload,status) VALUES(?,?,'pending')",
    [String(chatId),JSON.stringify({text:message,options})]
  );
}
export async function enqueueTelegramNotifications(notifications){
  for(const notification of notifications)await enqueueTelegramNotification(notification);
}
