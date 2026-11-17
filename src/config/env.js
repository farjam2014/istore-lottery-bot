import 'dotenv/config';
import { parseEnvironment } from './env-schema.js';

const parsed = parseEnvironment(process.env);
if (!parsed.success) {
  console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = Object.freeze({
  ...parsed.data,
  adminIds: new Set(parsed.data.BOT_ADMIN_IDS.split(',').map(x => x.trim()).filter(Boolean))
});
