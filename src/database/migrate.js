import {pool} from './pool.js';
import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';

const here=path.dirname(fileURLToPath(import.meta.url));
const splitSql=sql=>sql.split(/;\\s*(?:\\n|$)/).map(s=>s.trim()).filter(Boolean);
export async function migrate(){
  const base=await readFile(path.join(here,'schema.sql'),'utf8');
  const c=await pool.getConnection();
  try{
    for(const statement of splitSql(base))await c.query(statement);
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(120) PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    const dir=path.join(here,'migrations');
    const files=(await readdir(dir)).filter(x=>x.endsWith('.sql')).sort();
    for(const file of files){
      const sql=await readFile(path.join(dir,file),'utf8');
      const checksum=createHash('sha256').update(sql).digest('hex');
      const [[existing]]=await c.execute('SELECT checksum FROM schema_migrations WHERE version=?',[file]);
      if(existing){
        if(existing.checksum!==checksum)throw new Error('Applied migration was modified: '+file);
        continue;
      }
      for(const statement of splitSql(sql))await c.query(statement);
      await c.execute('INSERT INTO schema_migrations(version,checksum) VALUES(?,?)',[file,checksum]);
    }
  }finally{c.release();}
}
