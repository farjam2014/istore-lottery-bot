import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  BOT_TOKEN: z.string().min(20),
  BOT_ADMIN_IDS: z.string().default(''),
  MYSQL_HOST: z.string().min(1),
  MYSQL_PORT: z.coerce.number().int().positive().default(3306),
  MYSQL_DATABASE: z.string().regex(/^[A-Za-z0-9_]+$/),
  MYSQL_USER: z.string().min(1),
  MYSQL_PASSWORD: z.string(),
  MYSQL_MIGRATION_USER: z.string().min(1).optional(),
  MYSQL_MIGRATION_PASSWORD: z.string().min(1).optional(),
  MYSQL_POOL_SIZE: z.coerce.number().int().min(1).max(50).default(10),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Destructive retention cleanup stays disabled until the business/legal policy is approved.
  RETENTION_CLEANUP_ENABLED: z.enum(['true','false']).default('false').transform(value=>value==='true'),
  DRAW_SEED_ENCRYPTION_KEYS: z.string().optional(),
  DRAW_SEED_ENCRYPTION_KEY: z.string().optional(),
  DRAW_SEED_ACTIVE_KEY_ID: z.string().optional(),
  PRIVACY_NOTICE_URL: z.string().url().refine(value=>new URL(value).protocol==='https:').optional(),
  PRIVACY_NOTICE_VERSION: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/).optional()
}).superRefine((value,ctx)=>{
  if(value.NODE_ENV==='production'){
    const adminIds=value.BOT_ADMIN_IDS.split(',').map(id=>id.trim()).filter(Boolean);
    if(!adminIds.length)ctx.addIssue({code:'custom',path:['BOT_ADMIN_IDS'],message:'At least one production super-admin Telegram ID is required.'});
    if(adminIds.some(id=>!/^\d{5,20}$/.test(id)))ctx.addIssue({code:'custom',path:['BOT_ADMIN_IDS'],message:'Production super-admin IDs must be numeric Telegram IDs (5–20 digits).'});
    if(!value.MYSQL_PASSWORD)ctx.addIssue({code:'custom',path:['MYSQL_PASSWORD'],message:'A non-empty MySQL password is required in production.'});
    if(!value.PRIVACY_NOTICE_URL)ctx.addIssue({code:'custom',path:['PRIVACY_NOTICE_URL'],message:'A published privacy notice URL is required in production.'});
    if(!value.PRIVACY_NOTICE_VERSION)ctx.addIssue({code:'custom',path:['PRIVACY_NOTICE_VERSION'],message:'A privacy notice version is required in production.'});
    if(value.PRIVACY_NOTICE_URL){const host=new URL(value.PRIVACY_NOTICE_URL).hostname;if(['example.com','www.example.com','localhost'].includes(host)||host.endsWith('.example')||host.endsWith('.test')||host.endsWith('.invalid'))ctx.addIssue({code:'custom',path:['PRIVACY_NOTICE_URL'],message:'Replace the placeholder privacy notice URL with the published production notice.'});}
  }
});

export function parseEnvironment(environment) {
  return envSchema.safeParse(environment);
}
