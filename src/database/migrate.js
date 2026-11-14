import {pool} from './pool.js';import {readFile} from 'node:fs/promises';import {fileURLToPath} from 'node:url';import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url));
export async function migrate(){const sql=await readFile(path.join(here,'schema.sql'),'utf8');const statements=sql.split(/;\s*(?:\n|$)/).map(s=>s.trim()).filter(Boolean);const c=await pool.getConnection();try{for(const statement of statements)await c.query(statement);}finally{c.release();}}
