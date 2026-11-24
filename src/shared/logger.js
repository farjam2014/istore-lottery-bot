import pino from 'pino';
import {config} from '../config/env.js';
import {getCorrelationId} from './request-context.js';

export const logger=pino({
  level:config.LOG_LEVEL,
  mixin(){
    const correlationId=getCorrelationId();
    return correlationId?{correlationId}:{};
  },
  redact:{
    paths:['*.token','*.password','*.phone','*.card_number','*.cardNumber','*.telegram_file_id','*.telegram_file_unique_id','*.file_id','userId','*.userId','telegram_user_id','*.telegram_user_id','telegramUserId','*.telegramUserId','admin_telegram_id','*.admin_telegram_id','chat_id','*.chat_id','chatId','*.chatId','instagram_handle','*.instagram_handle','instagramHandle','*.instagramHandle','full_name','*.full_name','BOT_TOKEN','MYSQL_PASSWORD'],
    censor:'[REDACTED]'
  }
});
