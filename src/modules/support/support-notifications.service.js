import {config} from '../../config/env.js';
import {pool} from '../../database/pool.js';
import {enqueueTelegramNotification} from '../notifications/outbox.service.js';

export async function enqueueSupportAdminNotification({text,replyMarkup,executor=pool,adminIds=config.adminIds}){
  const [rows]=await executor.execute(
    "SELECT telegram_user_id FROM admin_users WHERE is_active=1 AND role IN ('super_admin','support_agent')"
  );
  const recipients=new Set([
    ...[...adminIds].map(String),
    ...rows.map(row=>String(row.telegram_user_id))
  ]);
  const options=replyMarkup?.reply_markup?{reply_markup:replyMarkup.reply_markup}:{};
  for(const chatId of recipients){
    await enqueueTelegramNotification({chatId,text,options,executor});
  }
  return recipients.size;
}
