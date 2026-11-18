import {pool} from './pool.js';
import {config} from '../config/env.js';
import {assertMigrationAllowed} from './migration-guard.js';
import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';

const here=path.dirname(fileURLToPath(import.meta.url));
const LOCK_NAME='ustore_telegram_bot_schema_migrations';
const splitSql=sql=>sql.split(/;\s*(?:\n|$)/).map(s=>s.trim()).filter(Boolean);

async function hasIndex(connection,table,index){
  const [[row]]=await connection.execute(
    'SELECT COUNT(*) AS total FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=?',
    [table,index]
  );
  return Number(row.total)>0;
}
async function hasColumn(connection,table,column){
  const [[row]]=await connection.execute(
    'SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',
    [table,column]
  );
  return Number(row.total)>0;
}
async function hasForeignKey(connection,table,constraint){
  const [[row]]=await connection.execute(
    'SELECT COUNT(*) AS total FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME=? AND CONSTRAINT_NAME=?',
    [table,constraint]
  );
  return Number(row.total)>0;
}
async function hasCheckConstraint(connection,table,constraint){
  const [[row]]=await connection.execute(
    "SELECT COUNT(*) AS total FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME=? AND CONSTRAINT_NAME=? AND CONSTRAINT_TYPE='CHECK'",
    [table,constraint]
  );
  return Number(row.total)>0;
}
async function hasTable(connection,table){
  const [[row]]=await connection.execute(
    'SELECT COUNT(*) AS total FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',
    [table]
  );
  return Number(row.total)>0;
}

// These guards make replay safe if MySQL committed DDL but the process stopped
// before schema_migrations could record the completed migration.
async function allSchemaChecks(connection,checks,message){
  const results=await Promise.all(checks);
  if(results.every(Boolean)) return true;
  if(results.some(Boolean)) throw new Error(message);
  return false;
}

async function migrationStatementAlreadyApplied(connection,file,index){
  if(file==='20261117_001_campaign_code_sequence.sql'){
    if(index===0){
      const [[legacyOverflow]]=await connection.execute(
        'SELECT campaign_id,COUNT(*) AS total FROM campaign_codes GROUP BY campaign_id HAVING COUNT(*)>999999 LIMIT 1'
      );
      if(legacyOverflow) throw new Error('Legacy campaign has more than 999999 issued codes; stop migration and reconcile sequence capacity before applying campaign code migration.');
      return hasIndex(connection,'campaign_entries','uq_entry_id_campaign');
    }
    if(index===1){
      const [[mismatchedCode]]=await connection.execute(
        'SELECT cc.id,cc.campaign_id AS code_campaign_id,ce.campaign_id AS entry_campaign_id FROM campaign_codes cc JOIN campaign_entries ce ON ce.id=cc.campaign_entry_id WHERE cc.campaign_id<>ce.campaign_id LIMIT 1'
      );
      if(mismatchedCode) throw new Error('Legacy campaign code '+mismatchedCode.id+' references campaign '+mismatchedCode.code_campaign_id+' but its entry belongs to campaign '+mismatchedCode.entry_campaign_id+'. Reconcile this data before applying the composite campaign-code foreign key.');
      const checks=await Promise.all([
        hasColumn(connection,'campaign_codes','sequence_number'),
        hasColumn(connection,'campaign_codes','random_prefix'),
        hasColumn(connection,'campaign_codes','random_suffix'),
        hasColumn(connection,'campaign_codes','format_version'),
        hasColumn(connection,'campaign_codes','status'),
        hasIndex(connection,'campaign_codes','uq_campaign_sequence'),
        hasIndex(connection,'campaign_codes','idx_campaign_code_status'),
        hasForeignKey(connection,'campaign_codes','fk_code_entry_campaign')
      ]);
      if(checks.every(Boolean)) return true;
      if(checks.some(Boolean)) throw new Error('Partial DDL detected in 20261117_001_campaign_code_sequence.sql (campaign_codes). Stop migration and inspect campaign_codes schema before repair.');
      return false;
    }
    if(index===2) return hasTable(connection,'campaign_code_counters');
    // Legacy sequence backfill and counter seeding are idempotent and safe to replay.
    return false;
  }
  if(file==='20261117_003_verifiable_campaign_draws.sql'){
    if(index===0) return allSchemaChecks(connection,[
      hasColumn(connection,'campaign_draws','winner_count'),
      hasColumn(connection,'campaign_draws','seed_ciphertext'),
      hasColumn(connection,'campaign_draws','seed_nonce'),
      hasColumn(connection,'campaign_draws','seed_tag'),
      hasColumn(connection,'campaign_draws','revealed_seed'),
      hasColumn(connection,'campaign_draws','candidate_snapshot_hash'),
      hasIndex(connection,'campaign_draws','uq_draw_id_campaign')
    ],'Partial DDL detected in verifiable campaign draw migration (campaign_draws). Inspect schema before repair.');
    if(index===1) return allSchemaChecks(connection,[
      hasIndex(connection,'campaign_codes','uq_campaign_code_id_campaign')
    ],'Partial DDL detected in verifiable campaign draw migration (campaign_codes). Inspect schema before repair.');
    if(index===2) return allSchemaChecks(connection,[
      hasColumn(connection,'draw_candidates','campaign_id'),
      hasColumn(connection,'draw_candidates','participant_id'),
      hasColumn(connection,'draw_candidates','code_snapshot'),
      hasIndex(connection,'draw_candidates','uq_draw_candidate_campaign'),
      hasIndex(connection,'draw_candidates','uq_candidate_id_draw_campaign'),
      hasForeignKey(connection,'draw_candidates','fk_candidate_draw_campaign'),
      hasForeignKey(connection,'draw_candidates','fk_candidate_code_campaign'),
      hasForeignKey(connection,'draw_candidates','fk_candidate_participant')
    ],'Partial DDL detected in verifiable campaign draw migration (draw_candidates). Inspect schema before repair.');
    if(index===3) return allSchemaChecks(connection,[
      hasColumn(connection,'draw_winners','campaign_id'),
      hasColumn(connection,'draw_winners','participant_id'),
      hasColumn(connection,'draw_winners','candidate_id'),
      hasColumn(connection,'draw_winners','code_snapshot'),
      hasIndex(connection,'draw_winners','uq_draw_winner_participant'),
      hasForeignKey(connection,'draw_winners','fk_winner_draw_campaign'),
      hasForeignKey(connection,'draw_winners','fk_winner_candidate'),
      hasForeignKey(connection,'draw_winners','fk_winner_candidate_draw'),
      hasForeignKey(connection,'draw_winners','fk_winner_code_campaign'),
      hasForeignKey(connection,'draw_winners','fk_winner_participant')
    ],'Partial DDL detected in verifiable campaign draw migration (draw_winners). Inspect schema before repair.');
  }
  if(file==='20261117_004_draw_commitment_publication.sql'){
    if(index===0) return allSchemaChecks(connection,[
      hasColumn(connection,'campaign_draws','commitment_publication_reference'),
      hasColumn(connection,'campaign_draws','commitment_published_at'),
      hasColumn(connection,'campaign_draws','commitment_published_by')
    ],'Partial DDL detected in draw commitment publication migration. Inspect campaign_draws before repair.');
    if(index===1){
      const [[step]]=await connection.execute(
        "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='admin_wizards' AND COLUMN_NAME='step'"
      );
      const requiredSteps=[
        'select_type','title','description','poster','prize_title','prize_description',
        'prize_value','starts_at','ends_at','draw_at','terms','capacity','codes',
        'price','payment_methods','confirm','payment_settings','payment_reject',
        'draw_publication_reference','draw_publication_confirm'
      ];
      const enumType=String(step?.COLUMN_TYPE||'');
      const hasPublicationStep=enumType.includes("'draw_publication_reference'")||enumType.includes("'draw_publication_confirm'");
      const ready=requiredSteps.every(value=>enumType.includes("'"+value+"'"));
      if(ready) return true;
      if(hasPublicationStep) throw new Error('Partial or incompatible DDL detected in admin_wizards publication workflow enum: one or more legacy wizard steps are missing. Inspect schema before repair.');
      return false;
    }
  }
  if(file==='20261117_006_draw_relational_integrity.sql'){
    if(index===0) return hasIndex(connection,'campaign_entries','uq_entry_campaign_participant');
    if(index===1) return hasIndex(connection,'campaign_codes','uq_code_entry_campaign_value');
    if(index===2){
      const [[legacy]]=await connection.execute('SELECT (SELECT COUNT(*) FROM draw_candidates)+(SELECT COUNT(*) FROM draw_winners) AS total');
      if(Number(legacy.total)>0) throw new Error('Draw relational-integrity migration requires empty legacy draw tables. Existing draw evidence must be reviewed and reconciled explicitly; no historical candidate snapshot will be inferred.');
      return hasColumn(connection,'draw_candidates','campaign_entry_id');
    }
    if(index===3){
      const [[rows]]=await connection.execute('SELECT COUNT(*) AS total FROM draw_candidates');
      if(Number(rows.total)>0) throw new Error('Draw candidates appeared during migration preflight. Stop and inspect before continuing.');
      return false; // Deterministic no-op backfill; safe to replay after interruption.
    }
    if(index===4) return allSchemaChecks(connection,[
      hasIndex(connection,'draw_candidates','uq_candidate_full_identity'),
      hasCheckConstraint(connection,'draw_candidates','chk_draw_candidate_identity_complete'),
      hasForeignKey(connection,'draw_candidates','fk_candidate_entry_participant'),
      hasForeignKey(connection,'draw_candidates','fk_candidate_code_entry_value')
    ],'Partial DDL detected in draw candidate relational-integrity constraints. Inspect draw_candidates before repair.');
    if(index===5) return hasColumn(connection,'draw_winners','campaign_entry_id');
    if(index===6){
      const [[rows]]=await connection.execute('SELECT COUNT(*) AS total FROM draw_winners');
      if(Number(rows.total)>0) throw new Error('Draw winners appeared during migration preflight. Stop and inspect before continuing.');
      return false; // Deterministic no-op backfill; safe to replay after interruption.
    }
    if(index===7) return allSchemaChecks(connection,[
      hasCheckConstraint(connection,'draw_winners','chk_draw_winner_identity_complete'),
      hasForeignKey(connection,'draw_winners','fk_winner_exact_candidate')
    ],'Partial DDL detected in draw winner relational-integrity constraints. Inspect draw_winners before repair.');
  }
  if(file==='20261117_005_draw_seed_keyring.sql' && index===0){
    const [[column]]=await connection.execute(
      "SELECT COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='campaign_draws' AND COLUMN_NAME='seed_key_id'"
    );
    if(!column) return false;
    if(String(column.COLUMN_TYPE).toLowerCase()!=='varchar(64)'||column.IS_NULLABLE!=='NO'||String(column.COLUMN_DEFAULT)!=='legacy-env') throw new Error('Unexpected existing campaign_draws.seed_key_id definition; inspect schema before replaying keyring migration.');
    return true;
  }
  if(file==='20261117_002_admin_campaign_code_search.sql' && index===0){
    const checks=await Promise.all([
      hasColumn(connection,'admin_search_sessions','campaign_id'),
      hasIndex(connection,'admin_search_sessions','idx_admin_search_campaign'),
      hasForeignKey(connection,'admin_search_sessions','fk_admin_search_campaign')
    ]);
    const [[step]]=await connection.execute(
      "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='admin_search_sessions' AND COLUMN_NAME='step'"
    );
    const enumReady=Boolean(step?.COLUMN_TYPE?.includes("'campaign_code'"));
    if(checks.every(Boolean) && enumReady) return true;
    if(checks.some(Boolean) || enumReady) throw new Error('Partial DDL detected in 20261117_002_admin_campaign_code_search.sql. Stop migration and inspect admin_search_sessions schema before repair.');
    return false;
  }
  if(file==='20261118_001_participant_search_state.sql' && index===0){
    const hasQueryText=await hasColumn(connection,'admin_search_sessions','query_text');
    const [[step]]=await connection.execute(
      "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='admin_search_sessions' AND COLUMN_NAME='step'"
    );
    const hasResultsStep=Boolean(step?.COLUMN_TYPE?.includes("'participant_results'"));
    if(hasQueryText&&hasResultsStep)return true;
    if(hasQueryText||hasResultsStep)throw new Error('Partial DDL detected in 20261118_001_participant_search_state.sql. Inspect admin_search_sessions before repair.');
    return false;
  }
  if(file==='20261118_002_paid_code_quantity.sql'){
    if(index===0){
      const [[column]]=await connection.execute(
        "SELECT COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='payment_orders' AND COLUMN_NAME='requested_code_count'"
      );
      if(!column) return false;
      if(String(column.COLUMN_TYPE).toLowerCase()==='smallint unsigned'&&column.IS_NULLABLE==='NO'&&String(column.COLUMN_DEFAULT)==='1') return true;
      throw new Error('Unexpected payment_orders.requested_code_count schema; inspect the table before migration recovery.');
    }
    return false; // The legacy-order backfill is deterministic and safe to replay.
  }
  return false;
}

export async function migrate(){
  assertMigrationAllowed({database:config.MYSQL_DATABASE,nodeEnv:config.NODE_ENV,host:config.MYSQL_HOST});
  const base=await readFile(path.join(here,'schema.sql'),'utf8');
  const c=await pool.getConnection();
  let lockAcquired=false;
  try{
    const [[lock]]=await c.query('SELECT GET_LOCK(?, 30) AS acquired',[LOCK_NAME]);
    lockAcquired=Number(lock?.acquired)===1;
    if(!lockAcquired)throw new Error('Could not acquire the database migration lock within 30 seconds.');

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
      const statements=splitSql(sql);
      for(let index=0;index<statements.length;index++){
        if(await migrationStatementAlreadyApplied(c,file,index)) continue;
        await c.query(statements[index]);
      }
      await c.execute('INSERT INTO schema_migrations(version,checksum) VALUES(?,?)',[file,checksum]);
    }
  }finally{
    if(lockAcquired){
      try{await c.query('SELECT RELEASE_LOCK(?)',[LOCK_NAME]);}catch{}
    }
    c.release();
  }
}
