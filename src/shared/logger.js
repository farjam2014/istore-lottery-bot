import pino from 'pino';
import {config} from '../config/env.js';
import {getCorrelationId} from './request-context.js';
import {logRedactPaths} from './log-redaction.js';

export const logger=pino({
  level:config.LOG_LEVEL,
  mixin(){
    const correlationId=getCorrelationId();
    return correlationId?{correlationId}:{};
  },
  redact:{
    paths:logRedactPaths,
    censor:'[REDACTED]'
  }
});
