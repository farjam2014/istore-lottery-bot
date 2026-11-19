import {pool} from '../../database/pool.js';
import {getCorrelationId} from '../../shared/request-context.js';

export async function enqueueTelegramNotification({chatId,text,photo,caption,options={},executor=pool}){
  const message=String(text??'').trim();
  const image=String(photo??'').trim();
  const photoCaption=String(caption??'').trim();
  if(!message&&(!image||!photoCaption))throw new Error('Notification text or a photo with caption is required.');
  if(image&&photoCaption.length>1024)throw new Error('Telegram photo caption must not exceed 1024 characters.');
  const payload={...(message?{text:message}:{}),...(image?{photo:image,caption:photoCaption}:{}),options};
  await executor.execute(
    "INSERT INTO telegram_notification_outbox(chat_id,correlation_id,payload,status) VALUES(?,?,?,'pending')",
    [String(chatId),getCorrelationId(),JSON.stringify(payload)]
  );
}

export async function enqueueTelegramNotifications(notifications){
  for(const notification of notifications)await enqueueTelegramNotification(notification);
}
