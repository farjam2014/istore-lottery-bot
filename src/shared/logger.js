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
    paths:['*.token','*.password','*.phone','*.card_number','*.cardNumber','*.telegram_file_id','*.telegram_file_unique_id','*.file_id','BOT_TOKEN','MYSQL_PASSWORD'],
    censor:'[REDACTED]'
  }
});
