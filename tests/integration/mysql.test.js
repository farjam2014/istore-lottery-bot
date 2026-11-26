import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import mysql from 'mysql2/promise';
// admin_audit_log is append-only after migration; unique fixture audit rows are intentionally retained.

const enabled=process.env.RUN_MYSQL_TESTS==='1';
const quoteIdentifier=value=>String.fromCharCode(96)+String(value).replaceAll(String.fromCharCode(96),String.fromCharCode(96)+String.fromCharCode(96))+String.fromCharCode(96);
async function clearFixtureSchema(connection,database){
  const [objects]=await connection.execute('SELECT TABLE_NAME,TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=?',[database]);
  await connection.query('SET FOREIGN_KEY_CHECKS=0');
  try{
    for(const object of objects){
      const kind=object.TABLE_TYPE==='VIEW'?'VIEW':'TABLE';
      await connection.query('DROP '+kind+' IF EXISTS '+quoteIdentifier(database)+'.'+quoteIdentifier(object.TABLE_NAME));
    }
  }finally{
    await connection.query('SET FOREIGN_KEY_CHECKS=1');
  }
}
async function assertFixtureSchemaEmpty(connection,database){
  const [[row]]=await connection.execute('SELECT COUNT(*) AS total FROM information_schema.TABLES WHERE TABLE_SCHEMA=?',[database]);
  assert.equal(Number(row.total),0,'Fixture schema '+database+' must be empty before the test.');
}


test('MySQL integration: production migration preflight runs against the baseline schema with a SELECT-only account',{skip:!enabled||!process.env.MYSQL_TEST_ADMIN_USER},async()=>{
  const host=process.env.MYSQL_HOST||'127.0.0.1';
  const port=Number(process.env.MYSQL_PORT||3306);
  const adminUser=process.env.MYSQL_TEST_ADMIN_USER;
  const adminPassword=process.env.MYSQL_TEST_ADMIN_PASSWORD||'';
  const reader=process.env.MYSQL_TEST_READONLY_USER;
  const readerPassword=process.env.MYSQL_TEST_READONLY_PASSWORD||'';
  const database=process.env.MYSQL_PREFLIGHT_DATABASE||'';
  assert.ok(adminUser&&reader&&readerPassword,'Dedicated fixture-admin and read-only accounts are required.');
  assert.match(database,/^ustore_preflight_[A-Za-z0-9_]+_ci$/,'A pre-provisioned preflight fixture schema is required.');
  assert.notEqual(database,process.env.MYSQL_DATABASE,'Preflight fixture schema must differ from the application test schema.');
  let admin,setup,readonly,fixtureStarted=false;
  try{
    admin=await mysql.createConnection({host,port,user:adminUser,password:adminPassword});
    await assertFixtureSchemaEmpty(admin,database);
    fixtureStarted=true;
    setup=await mysql.createConnection({host,port,user:adminUser,password:adminPassword,database});
    const schema=await readFile(new URL('../../src/database/schema.sql',import.meta.url),'utf8');
    for(const statement of schema.split(/;\s*(?:\n|$)/).map(x=>x.trim()).filter(Boolean))await setup.query(statement);
    await setup.query('CREATE TABLE schema_migrations (version VARCHAR(120) PRIMARY KEY,checksum CHAR(64) NOT NULL,applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    await setup.end();setup=null;
    readonly=await mysql.createConnection({host:'127.0.0.1',port,user:reader,password:readerPassword,database});
    const [[readerIdentity]]=await readonly.query("SELECT SUBSTRING_INDEX(CURRENT_USER(),'@',-1) AS account_host");
    const readerAccountHost=String(readerIdentity.account_host||'');
    assert.ok(readerAccountHost,'Could not identify the read-only MySQL account host.');
    const preflight=await readFile(new URL('../../scripts/production-migration-preflight.sql',import.meta.url),'utf8');
    const statements=preflight.split(/;\s*(?:\n|$)/).map(x=>x.trim()).filter(Boolean);
    const results=[];
    for(const statement of statements)results.push(await readonly.query(statement));
    const pending=results.flatMap(([rows])=>Array.isArray(rows)?rows:[]).filter(row=>row.check_status==='PENDING_MIGRATION_003');
    assert.equal(pending.length,2,'Baseline schema must report both draw snapshot checks as pending instead of referencing absent columns.');
    const rows=results.flatMap(([resultRows])=>Array.isArray(resultRows)?resultRows:[]);
    const pendingTables=rows.filter(row=>row.check_status==='PENDING_OR_MISSING_TABLE');
    assert.deepEqual([...new Set(pendingTables.map(row=>row.table_name).filter(Boolean))].sort(),['admin_action_idempotency','admin_role_sessions','admin_search_sessions','payment_admin_sessions','payment_card_admin_sessions','profile_change_sessions','support_sessions'],'Baseline preflight must report each migration-created session/idempotency table as pending.');
    assert.ok(rows.some(row=>row.table_name==='telegram_update_inbox'&&row.check_status==='PRESENT'&&Number(row.exact_rows)===0),'Baseline schema already contains an empty Telegram inbox table.');
    const pendingConsent=rows.filter(row=>row.check_status==='PENDING_MIGRATION_002');
    assert.equal(pendingConsent.length,1,'Baseline preflight must report privacy consent columns as pending without querying absent columns.');
    assert.ok(rows.every(row=>!Object.hasOwn(row,'payload')),'Read-only preflight must never return raw Telegram Update payloads.');
    const [schemaPrivileges]=await admin.execute("SELECT PRIVILEGE_TYPE FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE(?),'@',QUOTE(?)) AND TABLE_SCHEMA=? ORDER BY PRIVILEGE_TYPE",[reader,readerAccountHost,database]);
    const [globalPrivileges]=await admin.execute("SELECT PRIVILEGE_TYPE FROM information_schema.USER_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE(?),'@',QUOTE(?)) AND PRIVILEGE_TYPE<>'USAGE'",[reader,readerAccountHost]);
    const [[tablePrivilegeCount]]=await admin.execute("SELECT COUNT(*) AS total FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE(?),'@',QUOTE(?))",[reader,readerAccountHost]);
    const [otherSchemaPrivileges]=await admin.execute("SELECT TABLE_SCHEMA FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE(?),'@',QUOTE(?)) AND TABLE_SCHEMA<>?",[reader,readerAccountHost,database]);
    assert.deepEqual(schemaPrivileges.map(row=>row.PRIVILEGE_TYPE),['SELECT'],'Preflight fixture reader must have only SELECT on the target schema.');
    assert.deepEqual(globalPrivileges,[],'Preflight fixture reader must have no global privileges.');
    assert.equal(Number(tablePrivilegeCount.total),0,'Preflight fixture reader must have no table-specific grants.');
    assert.deepEqual(otherSchemaPrivileges,[],'Preflight fixture reader must have no grants on other schemas.');
  }finally{
    if(readonly)await readonly.end().catch(()=>{});
    if(setup)await setup.end().catch(()=>{});
    if(admin){
      if(fixtureStarted)await clearFixtureSchema(admin,database);
      await admin.end().catch(()=>{});
    }
  }
});



test('MySQL integration: draw relational-integrity migration rejects legacy draw rows before any DDL, then proceeds after reconciliation',{skip:!enabled||!process.env.MYSQL_TEST_ADMIN_USER},async()=>{
  const host=process.env.MYSQL_HOST||'127.0.0.1';
  const port=Number(process.env.MYSQL_PORT||3306);
  const adminUser=process.env.MYSQL_TEST_ADMIN_USER;
  const adminPassword=process.env.MYSQL_TEST_ADMIN_PASSWORD||'';
  const suffix=randomBytes(6).toString('hex');
  const database=process.env.MYSQL_DRAW_GUARD_DATABASE||'';
  assert.match(database,/^ustore_drawguard_[A-Za-z0-9_]+_ci$/,'A pre-provisioned draw-guard fixture schema is required.');
  assert.notEqual(database,process.env.MYSQL_DATABASE,'Draw-guard fixture schema must differ from the application test schema.');
  let admin,setup,fixtureStarted=false;
  const runMigration=stopBefore=>{
    const env={...process.env,NODE_ENV:'test',MYSQL_HOST:host,MYSQL_PORT:String(port),MYSQL_DATABASE:database,MYSQL_USER:adminUser,MYSQL_PASSWORD:adminPassword,ALLOW_DATABASE_MIGRATIONS:'1',ALLOW_TEST_DATABASE_MIGRATIONS:'1'};
    delete env.MYSQL_MIGRATION_USER;
    delete env.MYSQL_MIGRATION_PASSWORD;
    delete env.ALLOW_PRODUCTION_MIGRATIONS;
    delete env.MIGRATION_TARGET_DATABASE;
    const argument=stopBefore?'{stopBefore:'+JSON.stringify(stopBefore)+'}':'{}';
    const source='import {migrate} from "./src/database/migrate.js";\nimport {pool} from "./src/database/pool.js";\ntry{await migrate('+argument+');}finally{await pool.end();}';
    return spawnSync(process.execPath,['--input-type=module','-e',source],{cwd:process.cwd(),env,encoding:'utf8',timeout:120000,maxBuffer:2*1024*1024});
  };
  try{
    admin=await mysql.createConnection({host,port,user:adminUser,password:adminPassword});
    await assertFixtureSchemaEmpty(admin,database);
    fixtureStarted=true;
    const beforeDrawIntegrity='20261117_006_draw_relational_integrity.sql';
    const prepared=runMigration(beforeDrawIntegrity);
    assert.equal(prepared.status,0,prepared.stderr||prepared.stdout);
    setup=await mysql.createConnection({host,port,user:adminUser,password:adminPassword,database});
    const telegramUserId=String(690000000000000000n+BigInt(parseInt(suffix,16)));
    const code='MG'+suffix.toUpperCase();
    const [participant]=await setup.execute('INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)',[telegramUserId,'Migration Guard Fixture','+989120000000','migration_guard_'+suffix]);
    const [campaign]=await setup.execute("INSERT INTO campaigns(slug,title,status,participation_type,entry_price,codes_per_entry) VALUES(?,?,'closed','free',0,1)",['migration-guard-'+suffix,'Migration guard fixture']);
    const [entry]=await setup.execute("INSERT INTO campaign_entries(campaign_id,participant_id,profile_snapshot,status) VALUES(?,?,JSON_OBJECT('source','migration-guard'),'eligible')",[campaign.insertId,participant.insertId]);
    const [campaignCode]=await setup.execute('INSERT INTO campaign_codes(campaign_entry_id,campaign_id,code) VALUES(?,?,?)',[entry.insertId,campaign.insertId,code]);
    const [draw]=await setup.execute("INSERT INTO campaign_draws(campaign_id,status,algorithm,seed_hash,candidate_count,created_by) VALUES(?,'prepared','hmac-sha256-v1',?,1,123456)",[campaign.insertId,'a'.repeat(64)]);
    const [candidate]=await setup.execute('INSERT INTO draw_candidates(draw_id,campaign_id,participant_id,campaign_code_id,code_snapshot,candidate_hash) VALUES(?,?,?,?,?,?)',[draw.insertId,campaign.insertId,participant.insertId,campaignCode.insertId,code,'b'.repeat(64)]);
    await setup.execute('INSERT INTO draw_winners(draw_id,campaign_id,participant_id,candidate_id,campaign_code_id,code_snapshot,rank_position) VALUES(?,?,?,?,?,?,1)',[draw.insertId,campaign.insertId,participant.insertId,candidate.insertId,campaignCode.insertId,code]);
    const blocked=runMigration();
    assert.notEqual(blocked.status,0,'The migration runner must refuse to infer historical draw identity.');
    assert.match(blocked.stderr,/Draw relational-integrity migration requires empty legacy draw tables/);
    const [[candidateCount]]=await setup.query('SELECT COUNT(*) AS total FROM draw_candidates');
    const [[winnerCount]]=await setup.query('SELECT COUNT(*) AS total FROM draw_winners');
    const [[candidateColumn]]=await setup.query("SELECT COUNT(*) AS total FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='draw_candidates' AND column_name='campaign_entry_id'");
    const [[entryIndex]]=await setup.query("SELECT COUNT(*) AS total FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='campaign_entries' AND index_name='uq_entry_campaign_participant'");
    const [[codeIndex]]=await setup.query("SELECT COUNT(*) AS total FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='campaign_codes' AND index_name='uq_code_entry_campaign_value'");
    const [[migrationRecord]]=await setup.execute('SELECT COUNT(*) AS total FROM schema_migrations WHERE version=?',[beforeDrawIntegrity]);
    assert.equal(Number(candidateCount.total),1);
    assert.equal(Number(winnerCount.total),1);
    assert.equal(Number(candidateColumn.total),0,'No candidate backfill column may be added before legacy draw rows are reconciled.');
    assert.equal(Number(entryIndex.total),0,'No migration DDL may run before the legacy draw precondition.');
    assert.equal(Number(codeIndex.total),0,'No migration DDL may run before the legacy draw precondition.');
    assert.equal(Number(migrationRecord.total),0,'The blocked migration must not be marked applied.');
    await setup.execute('DELETE FROM draw_winners WHERE draw_id=?',[draw.insertId]);
    await setup.execute('DELETE FROM draw_candidates WHERE draw_id=?',[draw.insertId]);
    await setup.execute('DELETE FROM campaign_draws WHERE id=?',[draw.insertId]);
    await setup.execute('DELETE FROM campaign_codes WHERE id=?',[campaignCode.insertId]);
    await setup.execute('DELETE FROM campaign_entries WHERE id=?',[entry.insertId]);
    await setup.execute('DELETE FROM campaigns WHERE id=?',[campaign.insertId]);
    await setup.execute('DELETE FROM participants WHERE id=?',[participant.insertId]);
    const clean=runMigration();
    assert.equal(clean.status,0,clean.stderr||clean.stdout);
    const [[applied]]=await setup.execute('SELECT COUNT(*) AS total FROM schema_migrations WHERE version=?',[beforeDrawIntegrity]);
    const [[columnAfter]]=await setup.query("SELECT COUNT(*) AS total FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='draw_candidates' AND column_name='campaign_entry_id'");
    assert.equal(Number(applied.total),1,'The same migration must proceed once legacy draw rows are reconciled.');
    assert.equal(Number(columnAfter.total),1);
  }finally{
    if(setup)await setup.end().catch(()=>{});
    if(admin){
      if(fixtureStarted)await clearFixtureSchema(admin,database);
      await admin.end().catch(()=>{});
    }
  }
});


test('MySQL integration: clean schema, unique profile, multiple campaigns, frozen snapshot and idempotent codes',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/,'Integration tests only run against a database ending in _ci or _test');
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {createProfile,findByTelegramId,updatePrivacyConsent,saveSession,getSession,clearSession}=await import('../../src/modules/participants/participant.repository.js');
  const {joinFreeCampaign}=await import('../../src/modules/entries/entry.service.js');
  const {copyCampaign,createCampaignFromWizard}=await import('../../src/modules/campaigns/campaign-admin.service.js');
  let participantId;let secondParticipantId;const campaignIds=[];const extraCampaignIds=[];let telegramId;let secondTelegramId;let legacyParticipantId;let legacyCampaignId;let legacyEntryId;let legacyCodeId;let copyIdempotencyKey;let campaignWizardId;
  try{
    // Simulate a process crash after the first DDL statement of migration 001:
    // the index exists, but schema_migrations has not recorded the migration yet.
    const {readFile}=await import('node:fs/promises');
    const {fileURLToPath}=await import('node:url');
    const {dirname,resolve}=await import('node:path');
    const schemaPath=resolve(dirname(fileURLToPath(import.meta.url)),'../../src/database/schema.sql');
    const baseSql=await readFile(schemaPath,'utf8');
    for(const statement of baseSql.split(/;\s*(?:\n|$)/).map(x=>x.trim()).filter(Boolean)) await pool.query(statement);
    // Seed a pre-migration legacy record to prove sequence backfill preserves issuance history.
    const legacyUid=String(690000000000n+(BigInt(Date.now())%100000000000n));
    const [legacyP]=await pool.execute('INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)',[legacyUid,'Legacy Migration Tester','+989121234560','legacy_migration']);
    legacyParticipantId=legacyP.insertId;
    const [legacyC]=await pool.execute("INSERT INTO campaigns(slug,title,status,participation_type,codes_per_entry) VALUES(?,?,'closed','free',1)",['legacy-migration-'+legacyUid,'Legacy migration']);
    legacyCampaignId=legacyC.insertId;
    const [legacyE]=await pool.execute("INSERT INTO campaign_entries(campaign_id,participant_id,profile_snapshot,status) VALUES(?,?,JSON_OBJECT('legacy',true),'eligible')",[legacyCampaignId,legacyParticipantId]);
    legacyEntryId=legacyE.insertId;
    const [legacyCode]=await pool.execute('INSERT INTO campaign_codes(campaign_entry_id,campaign_id,code) VALUES(?,?,?)',[legacyEntryId,legacyCampaignId,'LEGACY-CODE-001']);
    legacyCodeId=legacyCode.insertId;
    const [[recoveryIndex]]=await pool.execute(
      "SELECT COUNT(*) total FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='campaign_entries' AND INDEX_NAME='uq_entry_id_campaign'"
    );
    if(Number(recoveryIndex.total)===0) await pool.query('ALTER TABLE campaign_entries ADD UNIQUE KEY uq_entry_id_campaign(id,campaign_id)');
    const [[migrationHistoryTable]]=await pool.execute("SELECT COUNT(*) AS total FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='schema_migrations'");
    if(Number(migrationHistoryTable.total)>0){
      await pool.execute("DELETE FROM schema_migrations WHERE version=?",["20261117_001_campaign_code_sequence.sql"]);
    }
    await migrate();

    // Execute the full preflight against the migrated schema on one connection:
    // its prepared statements use session variables and must work after all 28 migrations.
    const preflightSql=await readFile(new URL('../../scripts/production-migration-preflight.sql',import.meta.url),'utf8');
    const preflightConnection=await pool.getConnection();
    let preflightResults;
    try{
      preflightResults=[];
      for(const statement of preflightSql.split(/;\s*(?:\n|$)/).map(x=>x.trim()).filter(Boolean)){
        preflightResults.push(await preflightConnection.query(statement));
      }
    }finally{
      preflightConnection.release();
    }
    const preflightRows=preflightResults.flatMap(([resultRows])=>Array.isArray(resultRows)?resultRows:[]);
    assert.ok(preflightRows.some(row=>row.table_name==='telegram_update_inbox'&&row.check_status==='PRESENT'&&Number(row.exact_rows)===0));
    assert.ok(preflightRows.some(row=>row.table_name==='admin_action_idempotency'&&row.check_status==='PRESENT'&&Number(row.exact_rows)===0));
    assert.ok(preflightRows.some(row=>row.consent_version==='<NULL>'&&Number(row.participant_count)===1&&Number(row.missing_acceptance_timestamp_count)===1));
    assert.ok(preflightRows.every(row=>!Object.hasOwn(row,'payload')),'Migrated preflight must never return raw Telegram Update payloads.');

    // Re-accepting the privacy notice must preserve the registration replay cursor.
    const replaySessionId=String(690000000000n+(BigInt(Date.now())%100000000000n)+2n);
    await saveSession(replaySessionId,'awaiting_instagram',{privacyConsentVersion:'v1',privacyConsentAt:'2026-11-25T10:00:00.000Z'},123456);
    const savedReplaySession=await getSession(replaySessionId);
    assert.equal(savedReplaySession.lastUpdateId,123456,'Consent session save must retain the replay cursor.');
    await saveSession(replaySessionId,'awaiting_name',{privacyConsentVersion:'stale'},123455);
    const staleReplaySession=await getSession(replaySessionId);
    assert.equal(staleReplaySession.lastUpdateId,123456,'An older consent callback must not roll back the replay cursor.');
    assert.equal(staleReplaySession.step,'awaiting_instagram','An older consent callback must not overwrite the newer session step.');
    assert.equal(staleReplaySession.payload.privacyConsentVersion,'v1','An older consent callback must not overwrite the newer session payload.');
    await clearSession(replaySessionId);

    // Verify the current migration set and the complete legacy admin wizard contract.
    const expectedWizardSteps=[
      'select_type','title','description','poster','prize_title','prize_description',
      'prize_value','starts_at','ends_at','draw_at','terms','capacity','codes',
      'price','payment_methods','confirm','payment_settings','payment_reject',
      'draw_publication_reference','draw_publication_confirm','campaign_edit_value'
    ];
    const [[wizardColumn]]=await pool.execute(
      "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='admin_wizards' AND COLUMN_NAME='step'"
    );
    for(const step of expectedWizardSteps) assert.ok(wizardColumn.COLUMN_TYPE.includes("'"+step+"'"),'Missing admin_wizards.step enum value: '+step);
    const campaignEditAdminId=String(670000000000000000n+(BigInt(Date.now())%1000000000n));
    await pool.execute('INSERT INTO admin_wizards(telegram_user_id,step,payload) VALUES(?,?,?)',[campaignEditAdminId,'campaign_edit_value',JSON.stringify({campaignId:legacyCampaignId,field:'title'})]);
    const [[campaignEditWizard]]=await pool.execute('SELECT step,payload FROM admin_wizards WHERE telegram_user_id=?',[campaignEditAdminId]);
    assert.equal(campaignEditWizard.step,'campaign_edit_value');
    const campaignEditPayload=typeof campaignEditWizard.payload==='string'?JSON.parse(campaignEditWizard.payload):campaignEditWizard.payload;
    assert.equal(campaignEditPayload.campaignId,legacyCampaignId);
    assert.equal(campaignEditPayload.field,'title');
    await pool.execute('DELETE FROM admin_wizards WHERE telegram_user_id=?',[campaignEditAdminId]);
    const [[drawColumns]]=await pool.execute(
      "SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='campaign_draws' AND COLUMN_NAME IN ('winner_count','seed_ciphertext','seed_nonce','seed_tag','revealed_seed','candidate_snapshot_hash','commitment_publication_reference','commitment_published_at','commitment_published_by','seed_key_id')"
    );
    assert.equal(Number(drawColumns.total),10,'All draw migration columns must exist.');
    const [[searchStep]]=await pool.execute(
      "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='admin_search_sessions' AND COLUMN_NAME='step'"
    );
    assert.ok(searchStep.COLUMN_TYPE.includes("'campaign_code'"));
    assert.ok(searchStep.COLUMN_TYPE.includes("'participant_results'"));
    const [[searchQueryColumn]]=await pool.execute("SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='admin_search_sessions' AND COLUMN_NAME='query_text'");
    assert.equal(Number(searchQueryColumn.total),1,'Participant search query must persist for result pagination.');
    const [[adminRoleReplayColumn]]=await pool.execute("SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='admin_role_sessions' AND COLUMN_NAME='last_update_id'");
    const [[profileChangeReplayColumn]]=await pool.execute("SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='profile_change_sessions' AND COLUMN_NAME='last_update_id'");
    assert.equal(Number(profileChangeReplayColumn.total),1,'Profile-change sessions must persist their start update cursor.');
    assert.equal(Number(adminRoleReplayColumn.total),1,'Admin role assignment sessions must persist their start update cursor.');
    const [[requestedCodeCountColumn]]=await pool.execute("SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='payment_orders' AND COLUMN_NAME='requested_code_count'");
    const [[privacyConsentColumns]]=await pool.execute("SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='participants' AND COLUMN_NAME IN ('privacy_consent_version','privacy_consent_at')");
    assert.equal(Number(privacyConsentColumns.total),2,'Participant privacy consent fields must exist.');
    assert.equal(Number(requestedCodeCountColumn.total),1,'Paid order quantity snapshot column must exist.');
    const searchAdminId=String(680000000000000000n+(BigInt(Date.now())%1000000000n));
    await pool.execute("INSERT INTO admin_search_sessions(telegram_user_id,step,campaign_id,query_text) VALUES(?,'participant_results',NULL,?)",[searchAdminId,'09121234567']);
    const [[storedSearch]]=await pool.execute('SELECT step,query_text FROM admin_search_sessions WHERE telegram_user_id=?',[searchAdminId]);
    assert.equal(storedSearch.step,'participant_results');
    assert.equal(storedSearch.query_text,'09121234567');
    await pool.execute('DELETE FROM admin_search_sessions WHERE telegram_user_id=?',[searchAdminId]);
    for(const version of [
      '20261114_001_payment_expiry_reference.sql',
      '20261114_002_campaign_details.sql',
      '20261114_008_outbox_uncertain_delivery.sql',
      '20261115_009_correlation_and_delivery_history.sql',
      '20261117_001_campaign_code_sequence.sql',
      '20261117_002_admin_campaign_code_search.sql',
      '20261117_003_verifiable_campaign_draws.sql',
      '20261117_004_draw_commitment_publication.sql',
      '20261117_005_draw_seed_keyring.sql',
      '20261117_006_draw_relational_integrity.sql',
      '20261118_001_participant_search_state.sql',
      '20261118_002_paid_code_quantity.sql',
      '20261119_001_campaign_edit_wizard_step.sql',
      '20261124_001_admin_action_idempotency.sql',
      '20261124_002_privacy_consent.sql',
      '20261124_003_registration_session_replay.sql',
      '20261124_004_admin_wizard_replay.sql',
      '20261125_001_support_reply_replay.sql',
      '20261125_002_admin_search_replay.sql',
      '20261125_003_participant_session_replay.sql',
      '20261125_004_admin_audit_append_only.sql'
    ]){
      const [[record]]=await pool.execute('SELECT checksum FROM schema_migrations WHERE version=?',[version]);
      assert.match(record?.checksum||'',/^[a-f0-9]{64}$/,'Missing migration history record: '+version);
    }

    // Simulate DDL committed but migration history not recorded for legacy multi-statement migrations and later guarded migrations.
    for(const version of [
      '20261114_001_payment_expiry_reference.sql',
      '20261114_002_campaign_details.sql',
      '20261114_008_outbox_uncertain_delivery.sql',
      '20261115_009_correlation_and_delivery_history.sql',
      '20261124_001_admin_action_idempotency.sql',
      '20261124_002_privacy_consent.sql',
      '20261124_003_registration_session_replay.sql',
      '20261124_004_admin_wizard_replay.sql',
      '20261125_001_support_reply_replay.sql',
      '20261125_002_admin_search_replay.sql',
      '20261125_003_participant_session_replay.sql',
      '20261125_004_admin_audit_append_only.sql',
      '20261117_002_admin_campaign_code_search.sql',
      '20261117_003_verifiable_campaign_draws.sql',
      '20261117_004_draw_commitment_publication.sql',
      '20261117_006_draw_relational_integrity.sql',
      '20261118_001_participant_search_state.sql',
      '20261118_002_paid_code_quantity.sql',
      '20261119_001_campaign_edit_wizard_step.sql'
    ]){
      let preCursorSessionUserId=null;
      let preCursorRegistrationUserId=null;
      let preCursorAdminUserId=null;
      if(version==='20261124_003_registration_session_replay.sql'){
        preCursorRegistrationUserId=String(697000000000000000n+(BigInt(Date.now())%1000000000n));
        await pool.execute("INSERT INTO telegram_user_sessions(telegram_user_id,step,payload,last_update_id) VALUES(?,'awaiting_name',JSON_OBJECT(),NULL)",[preCursorRegistrationUserId]);
      }
      if(version==='20261124_004_admin_wizard_replay.sql'){
        preCursorAdminUserId=String(696000000000000000n+(BigInt(Date.now())%1000000000n));
        await pool.execute("INSERT INTO admin_wizards(telegram_user_id,step,payload,last_update_id) VALUES(?,'title',?,NULL)",[preCursorAdminUserId,JSON.stringify({title:'stale'})]);
        await pool.execute("INSERT INTO payment_card_admin_sessions(telegram_user_id,step,payload,last_update_id) VALUES(?,'bank_name',JSON_OBJECT(),NULL)",[preCursorAdminUserId]);
        await pool.execute("INSERT INTO admin_role_sessions(telegram_user_id,role,last_update_id) VALUES(?,'support_agent',NULL)",[preCursorAdminUserId]);
      }
      if(version==='20261125_003_participant_session_replay.sql'){
        preCursorSessionUserId=String(695000000000000000n+(BigInt(Date.now())%1000000000n));
        await pool.execute("INSERT INTO support_sessions(telegram_user_id,step,category,last_update_id) VALUES(?,'new_message','technical',NULL)",[preCursorSessionUserId]);
        await pool.execute("INSERT INTO profile_change_sessions(telegram_user_id,step,last_update_id) VALUES(?,'full_name',900003)",[preCursorSessionUserId]);
      }
      await pool.execute('DELETE FROM schema_migrations WHERE version=?',[version]);
      await migrate();
      const [[recovered]]=await pool.execute('SELECT checksum FROM schema_migrations WHERE version=?',[version]);
      assert.match(recovered?.checksum||'',/^[a-f0-9]{64}$/,'Replay guard failed for '+version);
      if(preCursorRegistrationUserId){
        const [[staleRegistrationSession]]=await pool.execute('SELECT COUNT(*) AS total FROM telegram_user_sessions WHERE telegram_user_id=?',[preCursorRegistrationUserId]);
        assert.equal(Number(staleRegistrationSession.total),0,'Pre-cursor registration sessions must be cleared on migration replay.');
      }
      if(preCursorAdminUserId){
        for(const table of ['admin_wizards','payment_card_admin_sessions','admin_role_sessions']){
          const [[staleAdminSession]]=await pool.execute('SELECT COUNT(*) AS total FROM `'+table+'` WHERE telegram_user_id=?',[preCursorAdminUserId]);
          assert.equal(Number(staleAdminSession.total),0,'Pre-cursor '+table+' rows must be cleared on migration replay.');
        }
      }
      if(preCursorSessionUserId){
        const [[staleSupportSession]]=await pool.execute('SELECT COUNT(*) AS total FROM support_sessions WHERE telegram_user_id=?',[preCursorSessionUserId]);
        const [[staleProfileSession]]=await pool.execute('SELECT COUNT(*) AS total FROM profile_change_sessions WHERE telegram_user_id=?',[preCursorSessionUserId]);
        assert.equal(Number(staleSupportSession.total),0,'Pre-cursor support sessions must be cleared on migration replay.');
        assert.equal(Number(staleProfileSession.total),0,'Pre-cursor profile sessions must be cleared on migration replay.');
      }
    }

    const [[recoveredMigration]]=await pool.execute("SELECT checksum FROM schema_migrations WHERE version='20261117_001_campaign_code_sequence.sql'");
    assert.match(recoveredMigration.checksum,/^[a-f0-9]{64}$/);
    const [[legacyMigrated]]=await pool.execute('SELECT sequence_number,format_version,status FROM campaign_codes WHERE id=?',[legacyCodeId]);
    assert.equal(Number(legacyMigrated.sequence_number),1);assert.equal(Number(legacyMigrated.format_version),1);assert.equal(legacyMigrated.status,'active');
    const [[legacyCounter]]=await pool.execute('SELECT last_sequence FROM campaign_code_counters WHERE campaign_id=?',[legacyCampaignId]);
    assert.equal(Number(legacyCounter.last_sequence),1);
    // Simulate a crash after migration 005 DDL committed but before its history row was recorded.
    await pool.execute("DELETE FROM schema_migrations WHERE version='20261117_005_draw_seed_keyring.sql'");
    await migrate();
    const [[keyringRecovery]]=await pool.execute("SELECT checksum FROM schema_migrations WHERE version='20261117_005_draw_seed_keyring.sql'");
    assert.match(keyringRecovery.checksum,/^[a-f0-9]{64}$/);
    const replaySessionUserId=String(690000000000000000n+(BigInt(Date.now())%1000000000n));
    try{
      await pool.execute("INSERT INTO support_sessions(telegram_user_id,step,category,last_update_id) VALUES(?,'new_message','technical',?)",[replaySessionUserId,900001]);
      await pool.execute("INSERT INTO profile_change_sessions(telegram_user_id,step,last_update_id) VALUES(?,'full_name',?)",[replaySessionUserId,900002]);
      const [[storedSupportCursor]]=await pool.execute('SELECT last_update_id FROM support_sessions WHERE telegram_user_id=?',[replaySessionUserId]);
      const [[storedProfileCursor]]=await pool.execute('SELECT last_update_id FROM profile_change_sessions WHERE telegram_user_id=?',[replaySessionUserId]);
      assert.equal(Number(storedSupportCursor.last_update_id),900001,'Support sessions must persist the session-start update ID.');
      assert.equal(Number(storedProfileCursor.last_update_id),900002,'Profile-change sessions must persist the session-start update ID.');
    }finally{
      await pool.execute('DELETE FROM support_sessions WHERE telegram_user_id=?',[replaySessionUserId]);
      await pool.execute('DELETE FROM profile_change_sessions WHERE telegram_user_id=?',[replaySessionUserId]);
    }
    const {issueCampaignCodes}=await import('../../src/modules/codes/code-issuance.service.js');
    const legacyConn=await pool.getConnection();let postMigrationCodes;try{await legacyConn.beginTransaction();postMigrationCodes=await issueCampaignCodes(legacyConn,legacyEntryId,legacyCampaignId,1);await legacyConn.commit();}catch(error){await legacyConn.rollback();throw error;}finally{legacyConn.release();}
    const [[nextLegacyCode]]=await pool.execute('SELECT sequence_number,format_version FROM campaign_codes WHERE campaign_entry_id=? AND code=?',[legacyEntryId,postMigrationCodes[0]]);
    assert.equal(Number(nextLegacyCode.sequence_number),2);assert.equal(Number(nextLegacyCode.format_version),2);
    telegramId=String(700000000000n+(BigInt(Date.now())%100000000000n));
    const consentAcceptedAt=new Date(Math.floor((Date.now()-60_000)/1000)*1000);
    await createProfile({telegramUserId:telegramId,username:'integration',fullName:'Integration Tester',phone:'+989121234567',instagramHandle:'integration_test',privacyConsentVersion:'ci-v1',privacyConsentAt:consentAcceptedAt});
    const profile=await findByTelegramId(telegramId);participantId=profile.id;
    assert.equal(profile.privacy_consent_version,'ci-v1');assert.equal(new Date(profile.privacy_consent_at).getTime(),consentAcceptedAt.getTime(),'Consent acceptance timestamp must match the recorded acceptance time.');
    await updatePrivacyConsent(telegramId,'ci-v2');
    const consentUpdated=await findByTelegramId(telegramId);
    assert.equal(consentUpdated.privacy_consent_version,'ci-v2');assert.ok(new Date(consentUpdated.privacy_consent_at).getTime()>consentAcceptedAt.getTime(),'Changing the privacy notice version must record the new acceptance timestamp.');
    const firstAcceptance=consentUpdated.privacy_consent_at;
    await updatePrivacyConsent(telegramId,'ci-v2');
    const consentReplayed=await findByTelegramId(telegramId);
    assert.equal(new Date(consentReplayed.privacy_consent_at).getTime(),new Date(firstAcceptance).getTime(),'Replayed consent callback must not refresh the first acceptance timestamp.');
    assert.equal(String(profile.telegram_user_id),telegramId);
    const duplicateProfile=await createProfile({telegramUserId:telegramId,username:'integration',fullName:'Duplicate Telegram',phone:'+989121234568',instagramHandle:'duplicate_telegram',privacyConsentVersion:'ci-v2',privacyConsentAt:new Date()});
    assert.equal(duplicateProfile.id,profile.id,'A repeated Telegram registration must return the existing profile.');
    assert.equal(duplicateProfile.privacy_consent_version,'ci-v2','Duplicate Telegram fallback must include consent metadata.');
    await assert.rejects(
      pool.execute('INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)',[telegramId,'Duplicate Tester','+989121234567','duplicate_user']),
      e=>e.code==='ER_DUP_ENTRY'
    );
    for(let i=0;i<2;i++){
      const [c]=await pool.execute("INSERT INTO campaigns(slug,title,status,participation_type,capacity,codes_per_entry) VALUES(?,?,'open','free',?,2)",[`it-${telegramId}-${i}`,`Integration campaign ${i}`,i===0?2:null]);
      campaignIds.push(c.insertId);
    }
    campaignWizardId=String(720000000000n+(BigInt(Date.now())%100000000000n));
    const wizardPayload={type:'free',title:'Atomic Wizard '+telegramId,description:'Integration wizard',codes:2,capacity:null,starts_at:null,ends_at:null,draw_at:null,posterFileId:null,prizeTitle:null,prizeDescription:null,prizeValue:null,terms:null};
    await pool.execute("INSERT INTO admin_wizards(telegram_user_id,step,payload) VALUES(?,'confirm',?)",[campaignWizardId,JSON.stringify(wizardPayload)]);
    const createdFromWizard=await createCampaignFromWizard({telegramUserId:campaignWizardId,actorId:telegramId});
    extraCampaignIds.push(createdFromWizard.campaignId);
    const [[wizardCampaign]]=await pool.execute('SELECT title,status,codes_per_entry FROM campaigns WHERE id=?',[createdFromWizard.campaignId]);
    assert.equal(wizardCampaign.title,wizardPayload.title);
    assert.equal(wizardCampaign.status,'draft');
    assert.equal(Number(wizardCampaign.codes_per_entry),2);
    await assert.rejects(createCampaignFromWizard({telegramUserId:campaignWizardId,actorId:telegramId}),/منقضی شده/);
    const [[wizardAuditCount]]=await pool.execute("SELECT COUNT(*) AS total FROM admin_audit_log WHERE action='campaign.created' AND entity_id=?",[createdFromWizard.campaignId]);
    assert.equal(Number(wizardAuditCount.total),1,'Campaign wizard creation must audit exactly once.');
    copyIdempotencyKey=createHash('sha256').update('campaign-copy-'+telegramId).digest('hex');
    const copyResults=await Promise.all([
      copyCampaign({campaignId:campaignIds[0],actorId:telegramId,idempotencyKey:copyIdempotencyKey}),
      copyCampaign({campaignId:campaignIds[0],actorId:telegramId,idempotencyKey:copyIdempotencyKey})
    ]);
    assert.equal(copyResults[0].campaignId,copyResults[1].campaignId,'Concurrent copy callbacks must resolve to the same campaign.');
    assert.equal(copyResults.filter(x=>x.alreadyProcessed).length,1,'Exactly one concurrent campaign-copy callback must be treated as a replay.');
    const copiedCampaignId=copyResults[0].campaignId;
    extraCampaignIds.push(copiedCampaignId);
    const [[copyCount]]=await pool.execute('SELECT COUNT(*) AS total FROM campaigns WHERE id=? AND title LIKE ?',[copiedCampaignId,'% (نسخه کپی)']);
    assert.equal(Number(copyCount.total),1);
    const [[copyAuditCount]]=await pool.execute("SELECT COUNT(*) AS total FROM admin_audit_log WHERE action='campaign.copied' AND entity_id=?",[copiedCampaignId]);
    assert.equal(Number(copyAuditCount.total),1,'Campaign copy and audit must commit exactly once.');
    const first=await joinFreeCampaign({telegramUserId:telegramId,campaignId:campaignIds[0]});
    assert.equal(first.codes.length,2);assert.equal(first.alreadyJoined,false);
    const repeated=await joinFreeCampaign({telegramUserId:telegramId,campaignId:campaignIds[0]});
    assert.equal(repeated.alreadyJoined,true);assert.deepEqual(repeated.codes,first.codes);
    const [[codeToRevoke]]=await pool.execute('SELECT MIN(id) AS id FROM campaign_codes WHERE campaign_entry_id=?',[first.entryId]);
    await pool.execute("UPDATE campaign_codes SET status='revoked' WHERE id=? AND campaign_entry_id=?",[codeToRevoke.id,first.entryId]);
    await assert.rejects(joinFreeCampaign({telegramUserId:telegramId,campaignId:campaignIds[0]}),/کدهای قبلی شما غیرفعال شده است/);
    await pool.execute("UPDATE campaign_codes SET status='active' WHERE campaign_entry_id=?",[first.entryId]);
    secondTelegramId=String(710000000000n+(BigInt(Date.now())%100000000000n));const secondProfile=await createProfile({telegramUserId:secondTelegramId,username:'integration2',fullName:'Capacity Tester',phone:'+989121234568',instagramHandle:'capacity_test',privacyConsentVersion:'ci-v1',privacyConsentAt:new Date()});secondParticipantId=secondProfile.id;
    await assert.rejects(joinFreeCampaign({telegramUserId:secondTelegramId,campaignId:campaignIds[0]}),/ظرفیت باقی/);
    const second=await joinFreeCampaign({telegramUserId:telegramId,campaignId:campaignIds[1]});
    assert.equal(second.codes.length,2);assert.notDeepEqual(second.codes,first.codes);
    for(const campaignId of campaignIds){
      const [issued]=await pool.execute('SELECT sequence_number,random_prefix,random_suffix,format_version,status,code FROM campaign_codes WHERE campaign_id=? ORDER BY sequence_number',[campaignId]);
      assert.deepEqual(issued.map(x=>Number(x.sequence_number)),[1,2]);
      assert.ok(issued.every(x=>Number(x.format_version)===2&&x.status==='active'&&x.code.length>0));
      assert.ok(issued.every(x=>String(x.random_prefix).length===5&&/^[ABCDEFGHJKLMNPQRSTUVWXYZ0123456789]*[A-Z0]$/.test(x.random_prefix)));
      assert.ok(issued.every(x=>/^[ABCDEFGHJKLMNPQRSTUVWXYZ0123456789][A-Z0]$/.test(x.random_suffix)));
    }
    await pool.execute("UPDATE participants SET full_name='Changed Name' WHERE id=?",[participantId]);
    const [[entry]]=await pool.execute('SELECT profile_snapshot FROM campaign_entries WHERE campaign_id=? AND participant_id=?',[campaignIds[0],participantId]);
    const snapshot=typeof entry.profile_snapshot==='string'?JSON.parse(entry.profile_snapshot):entry.profile_snapshot;
    assert.equal(snapshot.full_name,'Integration Tester');
    const [[count]]=await pool.execute('SELECT COUNT(*) AS total FROM campaign_codes WHERE campaign_id=?',[campaignIds[0]]);
    assert.equal(Number(count.total),2);
  }finally{
    for(const id of [participantId,secondParticipantId].filter(Boolean)){
      const [entries]=await pool.execute('SELECT id FROM campaign_entries WHERE participant_id=?',[id]);
      for(const e of entries)await pool.execute('DELETE FROM campaign_codes WHERE campaign_entry_id=?',[e.id]);
      await pool.execute('DELETE FROM campaign_entries WHERE participant_id=?',[id]);
      await pool.execute('DELETE FROM participants WHERE id=?',[id]);
    }
    const allCampaignIds=[...campaignIds,...extraCampaignIds];
    if(allCampaignIds.length){await pool.execute(`DELETE FROM campaigns WHERE id IN (${allCampaignIds.map(()=>'?').join(',')})`,allCampaignIds);}
    if(copyIdempotencyKey)await pool.execute('DELETE FROM admin_action_idempotency WHERE idempotency_key=?',[copyIdempotencyKey]);
    if(campaignWizardId)await pool.execute('DELETE FROM admin_wizards WHERE telegram_user_id=?',[campaignWizardId]);
    if(legacyEntryId)await pool.execute('DELETE FROM campaign_codes WHERE campaign_entry_id=?',[legacyEntryId]);
    if(legacyEntryId)await pool.execute('DELETE FROM campaign_entries WHERE id=?',[legacyEntryId]);
    if(legacyCampaignId)await pool.execute('DELETE FROM campaigns WHERE id=?',[legacyCampaignId]);
    if(legacyParticipantId)await pool.execute('DELETE FROM participants WHERE id=?',[legacyParticipantId]);
  }
});


test('MySQL integration: paid order receipt review is idempotent and codes issue only after approval',{skip:!enabled},async(t)=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {createOrGetOrder,submitReceipt,reviewReceipt,updatePaymentSettings,expirePendingOrders}=await import('../../src/modules/payments/payment.service.js');
  let participantId;let secondParticipantId;let campaignId;let orderId;let previousOrderId;let receiptId;let secondOrderId;let secondReceiptId;let repeatOrderId;let repeatReceiptId;let lastOrderId;let lastReceiptId;let raceOrderId;let telegramId;let secondTelegramId;let paymentCardId;const financeAdminId=String(890000000000n+(BigInt(Date.now())%100000000000n));
  try{
    await migrate();
    const [[existingCards]]=await pool.execute('SELECT COUNT(*) AS total FROM payment_bank_cards');
    if(Number(existingCards.total)>0){t.skip('Requires an empty disposable CI card table; refusing to modify pre-existing card records.');return;}
    telegramId=String(800000000000n+(BigInt(Date.now())%100000000000n));
    const [p]=await pool.execute("INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)",[telegramId,'Paid Integration','+989121111111','paid_test']);participantId=p.insertId;
    const [c]=await pool.execute("INSERT INTO campaigns(slug,title,status,participation_type,entry_price,capacity,codes_per_entry) VALUES(?,?,'open','paid',150000,3,5)",['paid-it-'+telegramId,'Paid integration']);campaignId=c.insertId;
    await updatePaymentSettings({bankName:'Test Bank',cardNumber:'1234567812345678',cardHolder:'Test Holder',instructions:'',adminId:'1'});
    const [[createdCard]]=await pool.execute('SELECT id FROM payment_bank_cards WHERE is_default=1 LIMIT 1');paymentCardId=createdCard?.id;
    const created=await createOrGetOrder({telegramUserId:telegramId,campaignId,requestedCodeCount:2});orderId=created.order.id;
    assert.equal(Number(created.order.amount),300000);assert.equal(Number(created.order.requested_code_count),2);
    secondTelegramId=String(810000000000n+(BigInt(Date.now())%100000000000n));const [p2]=await pool.execute('INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)',[secondTelegramId,'Paid Capacity Tester','+989121111112','paid_capacity_test']);secondParticipantId=p2.insertId;
    await assert.rejects(createOrGetOrder({telegramUserId:secondTelegramId,campaignId,requestedCodeCount:2}),/ظرفیت باقی/);
    const before=await pool.execute('SELECT COUNT(*) total FROM campaign_codes cc JOIN campaign_entries e ON e.id=cc.campaign_entry_id WHERE e.campaign_id=?',[campaignId]);
    assert.equal(Number(before[0][0].total),0);
    const repeated=await createOrGetOrder({telegramUserId:telegramId,campaignId,requestedCodeCount:2});assert.equal(repeated.order.id,orderId);assert.equal(repeated.order.card_number,'1234567812345678');await updatePaymentSettings({bankName:'Changed Bank',cardNumber:'8765432187654321',cardHolder:'Changed Holder',instructions:'changed',adminId:'1'});const [[cardSnapshot]]=await pool.execute('SELECT card_number FROM payment_orders WHERE id=?',[orderId]);assert.equal(cardSnapshot.card_number,'1234567812345678');previousOrderId=orderId;await pool.execute('UPDATE payment_orders SET expires_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 MINUTE) WHERE id=?',[orderId]);const [expirationCount,renewed]=await Promise.all([expirePendingOrders(),createOrGetOrder({telegramUserId:telegramId,campaignId,requestedCodeCount:2})]);assert.ok(expirationCount===0||expirationCount===1);const [[expiredOrder]]=await pool.execute('SELECT status FROM payment_orders WHERE id=?',[previousOrderId]);assert.equal(expiredOrder.status,'expired');orderId=renewed.order.id;assert.notEqual(orderId,previousOrderId);assert.equal(renewed.order.status,'awaiting_receipt');assert.match(renewed.order.payment_reference,/^ISTPAY-/);assert.equal(renewed.order.card_number,'8765432187654321');
    receiptId=(await submitReceipt({telegramUserId:telegramId,orderId,fileId:'file-test-1',fileUniqueId:'unique-test-'+telegramId,note:'test',adminIds:[financeAdminId]})).receiptId;const [[adminNotice]]=await pool.execute("SELECT payload FROM telegram_notification_outbox WHERE chat_id=? ORDER BY id DESC LIMIT 1",[financeAdminId]);const adminPayload=typeof adminNotice.payload==='string'?JSON.parse(adminNotice.payload):adminNotice.payload;assert.match(adminPayload.text,/رسید جدید برای سفارش/);assert.match(adminPayload.text,new RegExp(String(orderId)));assert.equal(adminPayload.photo,'file-test-1');assert.match(adminPayload.caption,/شناسه پرداخت:/);assert.match(adminPayload.caption,/کمپین:/);assert.match(adminPayload.caption,/موبایل:/);assert.doesNotMatch(adminPayload.caption,/اینستاگرام:/);assert.match(adminPayload.caption,/تعداد کد: 2/);assert.equal(adminPayload.options.reply_markup.inline_keyboard[0][0].callback_data,'payment:approve:'+receiptId);
    await assert.rejects(submitReceipt({telegramUserId:telegramId,orderId,fileId:'file-test-2',fileUniqueId:'unique-test-'+telegramId}),/قبلاً/);
    await reviewReceipt({adminId:'1',receiptId,decision:'reject',reason:'رسید آزمایشی نامعتبر'});
    const [[rejectionNotice]]=await pool.execute("SELECT payload FROM telegram_notification_outbox WHERE chat_id=? ORDER BY id DESC LIMIT 1",[telegramId]);
    const rejectionPayload=typeof rejectionNotice.payload==='string'?JSON.parse(rejectionNotice.payload):rejectionNotice.payload;
    assert.match(rejectionPayload.text,/رسید پرداخت سفارش/);assert.match(rejectionPayload.text,/رسید آزمایشی نامعتبر/);
    await assert.rejects(reviewReceipt({adminId:'1',receiptId,decision:'approve'}),/قبلاً/);
    const [afterReject]=await pool.execute('SELECT status FROM payment_orders WHERE id=?',[orderId]);assert.equal(afterReject[0].status,'rejected');
    const retry=await submitReceipt({telegramUserId:telegramId,orderId,fileId:'file-test-2',fileUniqueId:'unique-test-2-'+telegramId});
    await reviewReceipt({adminId:'1',receiptId:retry.receiptId,decision:'approve'});
    const [[approvalNotice]]=await pool.execute("SELECT payload FROM telegram_notification_outbox WHERE chat_id=? ORDER BY id DESC LIMIT 1",[telegramId]);
    const approvalPayload=typeof approvalNotice.payload==='string'?JSON.parse(approvalNotice.payload):approvalNotice.payload;
    assert.match(approvalPayload.text,/پرداخت سفارش/);assert.match(approvalPayload.text,/کدهای همین سفارش/);
    const [codes]=await pool.execute('SELECT cc.code,cc.sequence_number,cc.random_prefix,cc.random_suffix,cc.format_version FROM campaign_codes cc JOIN campaign_entries e ON e.id=cc.campaign_entry_id WHERE e.campaign_id=? ORDER BY cc.sequence_number',[campaignId]);
    assert.equal(codes.length,2);
    assert.deepEqual(codes.map(x=>Number(x.sequence_number)),[1,2]);
    assert.ok(codes.every(x=>Number(x.format_version)===2));
    await assert.rejects(reviewReceipt({adminId:'1',receiptId:retry.receiptId,decision:'approve'}),/قبلاً/);
    const [[order]]=await pool.execute('SELECT status,requested_code_count FROM payment_orders WHERE id=?',[orderId]);assert.equal(order.status,'approved');assert.equal(Number(order.requested_code_count),2);
    
    await assert.rejects(createOrGetOrder({telegramUserId:secondTelegramId,campaignId,requestedCodeCount:2}),/ظرفیت باقی/);
    const secondOrder=await createOrGetOrder({telegramUserId:secondTelegramId,campaignId,requestedCodeCount:1});secondOrderId=secondOrder.order.id;assert.equal(Number(secondOrder.order.amount),150000);assert.equal(Number(secondOrder.order.requested_code_count),1);
    secondReceiptId=(await submitReceipt({telegramUserId:secondTelegramId,orderId:secondOrderId,fileId:'file-test-3',fileUniqueId:'unique-test-3-'+secondTelegramId})).receiptId;await reviewReceipt({adminId:'1',receiptId:secondReceiptId,decision:'approve'});
    await pool.execute('UPDATE campaigns SET capacity=6 WHERE id=?',[campaignId]);
    const repeat=await createOrGetOrder({telegramUserId:telegramId,campaignId,requestedCodeCount:1});repeatOrderId=repeat.order.id;assert.notEqual(repeatOrderId,orderId);assert.equal(Number(repeat.order.requested_code_count),1);assert.equal(Number(repeat.order.amount),150000);
    const [[entryDuringRepeat]]=await pool.execute('SELECT status FROM campaign_entries WHERE campaign_id=? AND participant_id=?',[campaignId,participantId]);assert.equal(entryDuringRepeat.status,'eligible');
    const [codesBeforeRepeat]=await pool.execute('SELECT code FROM campaign_codes WHERE campaign_entry_id=(SELECT id FROM campaign_entries WHERE campaign_id=? AND participant_id=?)',[campaignId,participantId]);assert.equal(codesBeforeRepeat.length,2);repeatReceiptId=(await submitReceipt({telegramUserId:telegramId,orderId:repeatOrderId,fileId:'file-test-4',fileUniqueId:'unique-test-4-'+telegramId})).receiptId;await reviewReceipt({adminId:'1',receiptId:repeatReceiptId,decision:'approve'});const [[repeatApprovalNotice]]=await pool.execute('SELECT payload FROM telegram_notification_outbox WHERE chat_id=? ORDER BY id DESC LIMIT 1',[telegramId]);const repeatApprovalPayload=typeof repeatApprovalNotice.payload==='string'?JSON.parse(repeatApprovalNotice.payload):repeatApprovalNotice.payload;const repeatNotificationCodes=repeatApprovalPayload.text.split('کدهای همین سفارش:\n')[1].split('\n');assert.equal(repeatNotificationCodes.length,1,'Repeat-order approval must notify only the newly issued code');assert.ok(!codesBeforeRepeat.some(x=>repeatNotificationCodes.includes(x.code)),'Repeat-order notification must not resend earlier codes');
    const last=await createOrGetOrder({telegramUserId:telegramId,campaignId,requestedCodeCount:2});lastOrderId=last.order.id;assert.notEqual(lastOrderId,repeatOrderId);const lastReceipt=(await submitReceipt({telegramUserId:telegramId,orderId:lastOrderId,fileId:'file-test-5',fileUniqueId:'unique-test-5-'+telegramId})).receiptId;lastReceiptId=lastReceipt;await reviewReceipt({adminId:'1',receiptId:lastReceipt,decision:'approve'});
    await assert.rejects(createOrGetOrder({telegramUserId:telegramId,campaignId,requestedCodeCount:1}),/سقف باقی‌مانده/);
    await pool.execute('UPDATE campaigns SET capacity=7 WHERE id=?',[campaignId]);const raceOrder=await createOrGetOrder({telegramUserId:secondTelegramId,campaignId,requestedCodeCount:1});raceOrderId=raceOrder.order.id;await pool.execute('UPDATE payment_orders SET expires_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 MINUTE) WHERE id=?',[raceOrderId]);const [raceExpiry,raceSubmission]=await Promise.all([expirePendingOrders(),submitReceipt({telegramUserId:secondTelegramId,orderId:raceOrderId,fileId:'file-race',fileUniqueId:'unique-race-'+secondTelegramId})].map(p=>p.catch(error=>({error}))));assert.ok(raceExpiry===0||raceExpiry===1);assert.ok(raceSubmission?.error,'Submitting a receipt after expiry must fail');const [[raceOrderStatus]]=await pool.execute('SELECT status FROM payment_orders WHERE id=?',[raceOrderId]);assert.equal(raceOrderStatus.status,'expired');const [[raceReceiptCount]]=await pool.execute('SELECT COUNT(*) total FROM payment_receipts WHERE order_id=?',[raceOrderId]);assert.equal(Number(raceReceiptCount.total),0);const [finalCodes]=await pool.execute("SELECT code FROM campaign_codes WHERE campaign_id=? AND status='active'",[campaignId]);assert.equal(finalCodes.length,6);
  }finally{
    if(telegramId)await pool.execute('DELETE FROM telegram_notification_outbox WHERE chat_id=?',[telegramId]);if(secondTelegramId)await pool.execute('DELETE FROM telegram_notification_outbox WHERE chat_id=?',[secondTelegramId]);await pool.execute('DELETE FROM telegram_notification_outbox WHERE chat_id=?',[financeAdminId]);
    for(const id of [orderId,previousOrderId,secondOrderId,repeatOrderId,lastOrderId,raceOrderId].filter(Boolean)){await pool.execute('DELETE FROM payment_events WHERE order_id=?',[id]);await pool.execute('DELETE FROM payment_receipts WHERE order_id=?',[id]);await pool.execute('DELETE FROM payment_orders WHERE id=?',[id]);}
    for(const id of [participantId,secondParticipantId].filter(Boolean)){const [entries]=await pool.execute('SELECT id FROM campaign_entries WHERE participant_id=?',[id]);for(const e of entries)await pool.execute('DELETE FROM campaign_codes WHERE campaign_entry_id=?',[e.id]);await pool.execute('DELETE FROM campaign_entries WHERE participant_id=?',[id]);await pool.execute('DELETE FROM participants WHERE id=?',[id]);}
    if(campaignId)await pool.execute('DELETE FROM campaigns WHERE id=?',[campaignId]);
    if(paymentCardId)await pool.execute('DELETE FROM payment_bank_cards WHERE id=?',[paymentCardId]);
  }
});


test('MySQL integration: versioned campaign migration adds full public campaign metadata',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  try{
    await migrate();
    const [columns]=await pool.execute("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='campaigns'");
    const names=new Set(columns.map(x=>x.COLUMN_NAME));
    for(const name of ['poster_file_id','prize_title','prize_description','prize_value','draw_at','terms','payment_methods'])assert.ok(names.has(name),`Missing campaign column: ${name}`);
    const [[migration]]=await pool.execute("SELECT checksum FROM schema_migrations WHERE version='20261114_002_campaign_details.sql'");
    assert.match(migration.checksum,/^[a-f0-9]{64}$/);
  }finally{}
});


test('MySQL integration: support ticket tables and workflow constraints exist',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  try{
    await migrate();
    const [tables]=await pool.execute("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('support_tickets','support_messages','support_sessions')");
    assert.deepEqual(new Set(tables.map(x=>x.TABLE_NAME)),new Set(['support_tickets','support_messages','support_sessions']));
    const [[migration]]=await pool.execute("SELECT checksum FROM schema_migrations WHERE version='20261114_003_support_tickets.sql'");
    assert.match(migration.checksum,/^[a-f0-9]{64}$/);
    const [columns]=await pool.execute("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='support_tickets'");
    const names=new Set(columns.map(x=>x.COLUMN_NAME));
    for(const name of ['ticket_number','participant_id','category','subject','status','priority','assigned_admin_id','last_message_at'])assert.ok(names.has(name),`Missing support ticket column: ${name}`);
  }finally{}
});


test('MySQL integration: admin role tables and audit history schema exist',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  try{
    await migrate();
    const [tables]=await pool.execute("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('admin_users','admin_role_events','admin_role_sessions')");
    assert.deepEqual(new Set(tables.map(x=>x.TABLE_NAME)),new Set(['admin_users','admin_role_events','admin_role_sessions']));
    const [[migration]]=await pool.execute("SELECT checksum FROM schema_migrations WHERE version='20261114_004_admin_roles.sql'");
    assert.match(migration.checksum,/^[a-f0-9]{64}$/);
  }finally{}
});


test('MySQL integration: admin audit evidence rejects runtime UPDATE and DELETE', {skip:!enabled}, async()=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const actor=String(700000000000n+(BigInt(Date.now())%100000000000n));
  let auditId;
  try{
    await migrate();
    const [insert]=await pool.execute(
      "INSERT INTO admin_audit_log(admin_telegram_id,action,entity_type,entity_id,details) VALUES(?,'test.append_only','test_fixture',NULL,JSON_OBJECT('fixture',TRUE))",
      [actor]
    );
    auditId=insert.insertId;
    await assert.rejects(
      pool.execute('UPDATE admin_audit_log SET action=? WHERE id=?',['tampered',auditId]),
      error=>error.sqlState==='45000'||String(error.message).includes('append-only')
    );
    await assert.rejects(
      pool.execute('DELETE FROM admin_audit_log WHERE id=?',[auditId]),
      error=>error.sqlState==='45000'||String(error.message).includes('append-only')
    );
    const [[row]]=await pool.execute('SELECT action FROM admin_audit_log WHERE id=?',[auditId]);
    assert.equal(row.action,'test.append_only');
  }finally{}
});


test('MySQL integration: admin roles can be assigned changed and deactivated with audit events',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const id=String(800000000000n+(BigInt(Date.now())%100000000000n));
  try{
    await migrate();
    await pool.execute("INSERT INTO admin_users(telegram_user_id,role,is_active) VALUES(?,'support_agent',1)",[id]);
    const [[before]]=await pool.execute('SELECT role,is_active FROM admin_users WHERE telegram_user_id=?',[id]);
    assert.equal(before.role,'support_agent');assert.equal(Number(before.is_active),1);
    await pool.execute("UPDATE admin_users SET role='finance_manager' WHERE telegram_user_id=?",[id]);
    await pool.execute("UPDATE admin_users SET is_active=0 WHERE telegram_user_id=?",[id]);
    const [[after]]=await pool.execute('SELECT role,is_active FROM admin_users WHERE telegram_user_id=?',[id]);
    assert.equal(after.role,'finance_manager');assert.equal(Number(after.is_active),0);
  }finally{
    await pool.execute('DELETE FROM admin_users WHERE telegram_user_id=?',[id]);
  }
});


test('MySQL integration: management report aggregates return complete dashboard metrics',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {getManagementReport}=await import('../../src/modules/reports/management-report.service.js');
  try{
    await migrate();
    const report=await getManagementReport();
    for(const key of ['users','campaigns','entries','payments','receipts','topCampaigns','recent','newUsers'])assert.ok(Object.hasOwn(report,key),'Missing report section: '+key);
    assert.ok(Array.isArray(report.topCampaigns));
    for(const key of ['total','active','blocked'])assert.ok(Object.hasOwn(report.users,key));
    for(const key of ['total','approved_count','rejected_count','revenue','pending_amount'])assert.ok(Object.hasOwn(report.payments,key));
  }finally{}
});


test('MySQL integration: payment operations search filters detail and export are consistent',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {listManagedOrders,searchManagedOrders,getManagedOrderDetail,exportManagedOrders}=await import('../../src/modules/payments/payment-admin.service.js');
  let participantId,campaignId,entryId,orderId;
  const uid=String(850000000000n+(BigInt(Date.now())%100000000000n));
  const reference='ITPAY-'+uid;
  try{
    await migrate();
    const [p]=await pool.execute("INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)",[uid,'Payment Admin Test','+989123456789','payment_admin_test']);
    participantId=p.insertId;
    const [c]=await pool.execute("INSERT INTO campaigns(slug,title,status,participation_type,entry_price,codes_per_entry) VALUES(?,?,'open','paid',100000,1)",['pay-admin-'+uid,'Payment Admin Campaign']);
    campaignId=c.insertId;
    const [e]=await pool.execute("INSERT INTO campaign_entries(campaign_id,participant_id,profile_snapshot,status) VALUES(?,?,JSON_OBJECT('full_name','Payment Admin Test'),'pending_payment')",[campaignId,participantId]);
    entryId=e.insertId;
    const [o]=await pool.execute("INSERT INTO payment_orders(campaign_entry_id,payment_reference,amount,currency,status,expires_at) VALUES(?, ?,100000,'IRR','awaiting_receipt',DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 DAY))",[entryId,reference]);
    orderId=o.insertId;
    const list=await listManagedOrders({status:'awaiting_receipt',page:0,limit:10});
    assert.ok(list.rows.some(x=>Number(x.id)===Number(orderId)));
    const found=await searchManagedOrders(reference);
    assert.ok(found.some(x=>Number(x.id)===Number(orderId)));
    const detail=await getManagedOrderDetail(orderId);
    assert.equal(detail.order.payment_reference,reference);assert.equal(detail.receipts.length,0);
    const exported=await exportManagedOrders({status:'awaiting_receipt'});
    assert.ok(exported.some(x=>Number(x.id)===Number(orderId)));
  }finally{
    if(orderId){await pool.execute('DELETE FROM payment_events WHERE order_id=?',[orderId]);await pool.execute('DELETE FROM payment_receipts WHERE order_id=?',[orderId]);await pool.execute('DELETE FROM payment_orders WHERE id=?',[orderId]);}
    if(entryId){await pool.execute('DELETE FROM campaign_codes WHERE campaign_entry_id=?',[entryId]);await pool.execute('DELETE FROM campaign_entries WHERE id=?',[entryId]);}
    if(campaignId)await pool.execute('DELETE FROM campaigns WHERE id=?',[campaignId]);
    if(participantId)await pool.execute('DELETE FROM participants WHERE id=?',[participantId]);
  }
});

test('MySQL integration: payment admin search session migration exists',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');const {migrate}=await import('../../src/database/migrate.js');
  try{await migrate();const [tables]=await pool.execute("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='payment_admin_sessions'");assert.equal(tables.length,1);const [[m]]=await pool.execute("SELECT checksum FROM schema_migrations WHERE version='20261114_005_payment_admin_sessions.sql'");assert.match(m.checksum,/^[a-f0-9]{64}$/);}finally{}
});


test('MySQL integration: campaign code search session migration supports campaign-scoped search',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');const {migrate}=await import('../../src/database/migrate.js');
  await migrate();
  const [columns]=await pool.execute("SELECT COLUMN_NAME,COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='admin_search_sessions'");
  const step=columns.find(x=>x.COLUMN_NAME==='step');assert.ok(step);assert.match(step.COLUMN_TYPE,/campaign_code/);
  assert.ok(columns.some(x=>x.COLUMN_NAME==='campaign_id'));
});

test('MySQL integration: concurrent free entries receive unique sequential campaign codes',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');const {migrate}=await import('../../src/database/migrate.js');const {joinFreeCampaign}=await import('../../src/modules/entries/entry.service.js');
  const ids=[1,2,3,4].map(n=>String(BigInt(760000000000+n*10000000000)+(BigInt(Date.now())%1000000000n)));const participantIds=[];let campaignId;
  try{
    await migrate();
    for(let i=0;i<ids.length;i++){const [p]=await pool.execute("INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)",[ids[i],'Sequence Race '+i,'+98912144444'+i,'sequence_race_'+i]);participantIds.push(p.insertId);}
    const [c]=await pool.execute("INSERT INTO campaigns(slug,title,status,participation_type,codes_per_entry) VALUES(?,?,'open','free',2)",['sequence-race-'+ids[0],'Sequence race']);campaignId=c.insertId;
    const outcomes=await Promise.all(ids.map(telegramUserId=>joinFreeCampaign({telegramUserId,campaignId})));
    assert.ok(outcomes.every(x=>x.codes.length===2));
    const [rows]=await pool.execute('SELECT sequence_number,code FROM campaign_codes WHERE campaign_id=? ORDER BY sequence_number',[campaignId]);
    assert.deepEqual(rows.map(x=>Number(x.sequence_number)),[1,2,3,4,5,6,7,8]);
    assert.equal(new Set(rows.map(x=>x.code)).size,8);
    const [[counter]]=await pool.execute('SELECT last_sequence FROM campaign_code_counters WHERE campaign_id=?',[campaignId]);assert.equal(Number(counter.last_sequence),8);
  }finally{
    if(campaignId){const [entries]=await pool.execute('SELECT id FROM campaign_entries WHERE campaign_id=?',[campaignId]);for(const e of entries)await pool.execute('DELETE FROM campaign_codes WHERE campaign_entry_id=?',[e.id]);await pool.execute('DELETE FROM campaign_entries WHERE campaign_id=?',[campaignId]);await pool.execute('DELETE FROM campaigns WHERE id=?',[campaignId]);}
    for(const id of participantIds)await pool.execute('DELETE FROM participants WHERE id=?',[id]);
  }
});
test('MySQL integration: failure after the first code insert rolls back all codes and the counter',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {issueCampaignCodes}=await import('../../src/modules/codes/code-issuance.service.js');
  const suffix=String(Date.now());let campaignId,participantId,entryId;
  try{
    await migrate();
    const [participant]=await pool.execute(
      "INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)",
      [String(990000000000n+(BigInt(Date.now())%10000000000n)),'Rollback Integration','+989121555555','rollback_integration']
    );
    participantId=participant.insertId;
    const [campaign]=await pool.execute(
      "INSERT INTO campaigns(slug,title,status,participation_type,codes_per_entry) VALUES(?,?,'open','free',3)",
      ['code-rollback-'+suffix,'Code rollback']
    );
    campaignId=campaign.insertId;
    const [entry]=await pool.execute(
      "INSERT INTO campaign_entries(campaign_id,participant_id,profile_snapshot,status) VALUES(?,?,JSON_OBJECT('full_name','Rollback Integration'),'eligible')",
      [campaignId,participantId]
    );
    entryId=entry.insertId;
    await pool.execute('INSERT INTO campaign_code_counters(campaign_id,last_sequence) VALUES(?,0)',[campaignId]);
    const connection=await pool.getConnection();
    let codeInsertAttempts=0;
    const failingConnection={
      execute:async(sql,params)=>{
        if(/^\s*INSERT INTO campaign_codes/i.test(sql) && ++codeInsertAttempts===2){
          throw new Error('injected second-code insert failure');
        }
        return connection.execute(sql,params);
      }
    };
    let transactionOpen=false;
    try{
      await connection.beginTransaction();
      transactionOpen=true;
      await assert.rejects(issueCampaignCodes(failingConnection,entryId,campaignId,3),/injected second-code insert failure/);
      assert.equal(codeInsertAttempts,2,'The failure must occur after one successful code insert.');
      await connection.rollback();
      transactionOpen=false;
    }finally{
      if(transactionOpen) await connection.rollback();
      connection.release();
    }
    const [[counter]]=await pool.execute('SELECT last_sequence FROM campaign_code_counters WHERE campaign_id=?',[campaignId]);
    const [[codes]]=await pool.execute('SELECT COUNT(*) total FROM campaign_codes WHERE campaign_id=?',[campaignId]);
    assert.equal(Number(counter.last_sequence),0);
    assert.equal(Number(codes.total),0);
  }finally{
    if(entryId)await pool.execute('DELETE FROM campaign_codes WHERE campaign_entry_id=?',[entryId]);
    if(entryId)await pool.execute('DELETE FROM campaign_entries WHERE id=?',[entryId]);
    if(campaignId)await pool.execute('DELETE FROM campaigns WHERE id=?',[campaignId]);
    if(participantId)await pool.execute('DELETE FROM participants WHERE id=?',[participantId]);
  }
});

test('MySQL integration: update guard and profile change workflow schema are available',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  try{
    await migrate();
    const [tables]=await pool.execute("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('admin_search_sessions','telegram_rate_limits','processed_updates','profile_change_sessions','profile_change_requests')");
    const names=new Set(tables.map(x=>x.TABLE_NAME));
    for(const name of ['admin_search_sessions','telegram_rate_limits','processed_updates','profile_change_sessions','profile_change_requests'])assert.ok(names.has(name),'Missing workflow table: '+name);
    const [[migration]]=await pool.execute("SELECT checksum FROM schema_migrations WHERE version='20261114_007_profile_change_sessions.sql'");
    assert.match(migration.checksum,/^[a-f0-9]{64}$/);
  }finally{}
});


test('MySQL integration: concurrent free registrations cannot exceed campaign capacity',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');const {migrate}=await import('../../src/database/migrate.js');const {joinFreeCampaign}=await import('../../src/modules/entries/entry.service.js');
  const ids=[String(710000000000n+(BigInt(Date.now())%100000000000n)),String(720000000000n+(BigInt(Date.now())%100000000000n))];const participantIds=[];let campaignId;
  try{await migrate();for(let i=0;i<2;i++){const [p]=await pool.execute("INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)",[ids[i],'Capacity Race '+i,'+98912111111'+i,'capacity_race_'+i]);participantIds.push(p.insertId);}
    const [c]=await pool.execute("INSERT INTO campaigns(slug,title,status,participation_type,capacity,codes_per_entry) VALUES(?,?,'open','free',1,1)",['capacity-race-'+ids[0],'Capacity race']);campaignId=c.insertId;
    const outcomes=await Promise.allSettled(ids.map(telegramUserId=>joinFreeCampaign({telegramUserId,campaignId})));
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
    const [[count]]=await pool.execute("SELECT COUNT(*) total FROM campaign_entries WHERE campaign_id=? AND status IN ('eligible','pending_payment')",[campaignId]);assert.equal(Number(count.total),1);
    const [[codes]]=await pool.execute("SELECT COUNT(*) total FROM campaign_codes WHERE campaign_id=?",[campaignId]);assert.equal(Number(codes.total),1);
  }finally{if(campaignId){const [entries]=await pool.execute('SELECT id FROM campaign_entries WHERE campaign_id=?',[campaignId]);for(const e of entries)await pool.execute('DELETE FROM campaign_codes WHERE campaign_entry_id=?',[e.id]);await pool.execute('DELETE FROM campaign_entries WHERE campaign_id=?',[campaignId]);await pool.execute('DELETE FROM campaigns WHERE id=?',[campaignId]);}for(const id of participantIds)await pool.execute('DELETE FROM participants WHERE id=?',[id]);}
});

test('MySQL integration: concurrent paid orders serialize capacity and remain idempotent',{skip:!enabled},async(t)=>{
  const db=process.env.MYSQL_DATABASE||'';assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');const {migrate}=await import('../../src/database/migrate.js');const {createOrGetOrder,updatePaymentSettings}=await import('../../src/modules/payments/payment.service.js');
  const ids=[String(730000000000n+(BigInt(Date.now())%100000000000n)),String(740000000000n+(BigInt(Date.now())%100000000000n))];const participantIds=[];let campaignId,paymentCardId;
  try{await migrate();const [[existingCards]]=await pool.execute('SELECT COUNT(*) AS total FROM payment_bank_cards');if(Number(existingCards.total)>0){t.skip('Requires an empty disposable CI card table; refusing to modify pre-existing card records.');return;}for(let i=0;i<2;i++){const [p]=await pool.execute("INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)",[ids[i],'Paid Capacity '+i,'+98912122222'+i,'paid_capacity_'+i]);participantIds.push(p.insertId);}
    const [c]=await pool.execute("INSERT INTO campaigns(slug,title,status,participation_type,entry_price,capacity,codes_per_entry) VALUES(?,?,'open','paid',100000,1,1)",['paid-capacity-'+ids[0],'Paid capacity race']);campaignId=c.insertId;
    await updatePaymentSettings({bankName:'CI Bank',cardNumber:'1234567812345678',cardHolder:'CI Holder',instructions:'',adminId:'1'});const [[createdCard]]=await pool.execute('SELECT id FROM payment_bank_cards WHERE is_default=1 LIMIT 1');paymentCardId=createdCard?.id;
    const outcomes=await Promise.allSettled(ids.map(telegramUserId=>createOrGetOrder({telegramUserId,campaignId})));
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
    const [[entries]]=await pool.execute("SELECT COUNT(*) total FROM campaign_entries WHERE campaign_id=? AND status IN ('eligible','pending_payment')",[campaignId]);assert.equal(Number(entries.total),1);
    const [[orders]]=await pool.execute("SELECT COUNT(*) total FROM payment_orders o JOIN campaign_entries e ON e.id=o.campaign_entry_id WHERE e.campaign_id=? AND o.status IN ('awaiting_receipt','under_review','approved','rejected')",[campaignId]);assert.equal(Number(orders.total),1);
    const winnerIndex=outcomes.findIndex(x=>x.status==='fulfilled');const repeated=await createOrGetOrder({telegramUserId:ids[winnerIndex],campaignId});assert.equal(repeated.order.id,outcomes[winnerIndex].value.order.id);
    const [[entryCount]]=await pool.execute('SELECT COUNT(*) total FROM campaign_entries WHERE campaign_id=?',[campaignId]);assert.equal(Number(entryCount.total),1);
  }finally{if(campaignId){const [entries]=await pool.execute('SELECT id FROM campaign_entries WHERE campaign_id=?',[campaignId]);for(const e of entries){const [orders]=await pool.execute('SELECT id FROM payment_orders WHERE campaign_entry_id=?',[e.id]);for(const o of orders){await pool.execute('DELETE FROM payment_events WHERE order_id=?',[o.id]);await pool.execute('DELETE FROM payment_receipts WHERE order_id=?',[o.id]);await pool.execute('DELETE FROM payment_orders WHERE id=?',[o.id]);}await pool.execute('DELETE FROM campaign_codes WHERE campaign_entry_id=?',[e.id]);}await pool.execute('DELETE FROM campaign_entries WHERE campaign_id=?',[campaignId]);await pool.execute('DELETE FROM campaigns WHERE id=?',[campaignId]);}for(const id of participantIds)await pool.execute('DELETE FROM participants WHERE id=?',[id]);if(paymentCardId)await pool.execute('DELETE FROM payment_bank_cards WHERE id=?',[paymentCardId]);}
});

test('MySQL integration: concurrent receipt approvals issue codes and financial effects exactly once',{skip:!enabled},async(t)=>{
  const db=process.env.MYSQL_DATABASE||'';assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');const {migrate}=await import('../../src/database/migrate.js');const {createOrGetOrder,submitReceipt,reviewReceipt,updatePaymentSettings}=await import('../../src/modules/payments/payment.service.js');
  const uid=String(750000000000n+(BigInt(Date.now())%100000000000n));let participantId,campaignId,orderId,receiptId,paymentCardId;
  try{await migrate();const [[existingCards]]=await pool.execute('SELECT COUNT(*) AS total FROM payment_bank_cards');if(Number(existingCards.total)>0){t.skip('Requires an empty disposable CI card table; refusing to modify pre-existing card records.');return;}const [p]=await pool.execute("INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)",[uid,'Concurrent Review','+989121333333','concurrent_review']);participantId=p.insertId;
    const [c]=await pool.execute("INSERT INTO campaigns(slug,title,status,participation_type,entry_price,codes_per_entry) VALUES(?,?,'open','paid',100000,3)",['review-race-'+uid,'Review race']);campaignId=c.insertId;
    await updatePaymentSettings({bankName:'CI Bank',cardNumber:'1234567812345678',cardHolder:'CI Holder',instructions:'',adminId:'1'});const [[createdCard]]=await pool.execute('SELECT id FROM payment_bank_cards WHERE is_default=1 LIMIT 1');paymentCardId=createdCard?.id;
    const order=await createOrGetOrder({telegramUserId:uid,campaignId,requestedCodeCount:3});orderId=order.order.id;receiptId=(await submitReceipt({telegramUserId:uid,orderId,fileId:'review-race-file-'+uid,fileUniqueId:'review-race-unique-'+uid})).receiptId;
    const outcomes=await Promise.allSettled([reviewReceipt({adminId:'9001',receiptId,decision:'approve'}),reviewReceipt({adminId:'9002',receiptId,decision:'approve'})]);
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
    const [[orderState]]=await pool.execute('SELECT status FROM payment_orders WHERE id=?',[orderId]);assert.equal(orderState.status,'approved');
    const [[entryState]]=await pool.execute('SELECT status FROM campaign_entries WHERE id=(SELECT campaign_entry_id FROM payment_orders WHERE id=?)',[orderId]);assert.equal(entryState.status,'eligible');
    const [[codeCount]]=await pool.execute('SELECT COUNT(*) total FROM campaign_codes WHERE campaign_entry_id=(SELECT campaign_entry_id FROM payment_orders WHERE id=?)',[orderId]);assert.equal(Number(codeCount.total),3);
    const [[eventCount]]=await pool.execute("SELECT COUNT(*) total FROM payment_events WHERE order_id=? AND event_type='payment_approved'",[orderId]);assert.equal(Number(eventCount.total),1);
    const [[noticeCount]]=await pool.execute("SELECT COUNT(*) total FROM telegram_notification_outbox WHERE chat_id=? AND payload LIKE '%پرداخت سفارش%'",[uid]);assert.equal(Number(noticeCount.total),1);
  }finally{if(uid)await pool.execute('DELETE FROM telegram_notification_outbox WHERE chat_id=?',[uid]);if(orderId){await pool.execute('DELETE FROM payment_events WHERE order_id=?',[orderId]);await pool.execute('DELETE FROM payment_receipts WHERE order_id=?',[orderId]);await pool.execute('DELETE FROM payment_orders WHERE id=?',[orderId]);}if(participantId){const [entries]=await pool.execute('SELECT id FROM campaign_entries WHERE participant_id=?',[participantId]);for(const e of entries)await pool.execute('DELETE FROM campaign_codes WHERE campaign_entry_id=?',[e.id]);await pool.execute('DELETE FROM campaign_entries WHERE participant_id=?',[participantId]);await pool.execute('DELETE FROM participants WHERE id=?',[participantId]);}if(campaignId)await pool.execute('DELETE FROM campaigns WHERE id=?',[campaignId]);if(paymentCardId)await pool.execute('DELETE FROM payment_bank_cards WHERE id=?',[paymentCardId]);}
});


test('MySQL integration: last active database super admin cannot be deactivated or demoted',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');const {migrate}=await import('../../src/database/migrate.js');
  const {setAdminActive,changeAdminRole}=await import('../../src/modules/admin/admin-access.service.js');
  const suffix=String(Date.now()).slice(-10);const ids=[String(760000000000n+BigInt(suffix)),String(770000000000n+BigInt(suffix))];
  try{
    await migrate();
    await pool.execute("INSERT INTO admin_users(telegram_user_id,role,is_active) VALUES(?,'super_admin',1),(?,'super_admin',1)",ids);
    await setAdminActive({targetId:ids[0],actorId:'9000',expectedActive:1,isActive:0});
    const [[remaining]]=await pool.execute("SELECT COUNT(*) total FROM admin_users WHERE role='super_admin' AND is_active=1 AND telegram_user_id IN (?,?)",ids);
    assert.equal(Number(remaining.total),1);
    await assert.rejects(setAdminActive({targetId:ids[1],actorId:'9000',expectedActive:1,isActive:0}),/آخرین مدیر کل فعال/);
    await assert.rejects(changeAdminRole({targetId:ids[1],actorId:'9000',role:'finance_manager'}),/آخرین مدیر کل فعال/);
    const [[last]]=await pool.execute('SELECT role,is_active FROM admin_users WHERE telegram_user_id=?',[ids[1]]);
    assert.equal(last.role,'super_admin');assert.equal(Number(last.is_active),1);
  }finally{await pool.execute('DELETE FROM admin_role_events WHERE target_telegram_id IN (?,?)',ids);await pool.execute('DELETE FROM admin_users WHERE telegram_user_id IN (?,?)',ids);}
});


test('MySQL integration: transactional outbox notifications roll back and commit with business changes',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');const {migrate}=await import('../../src/database/migrate.js');
  const {enqueueTelegramNotification}=await import('../../src/modules/notifications/outbox.service.js');
  const chatId=String(780000000000n+(BigInt(Date.now())%100000000000n));
  try{
    await migrate();
    const rollback=await pool.getConnection();try{await rollback.beginTransaction();await enqueueTelegramNotification({chatId,text:'must rollback',executor:rollback});await rollback.rollback();}finally{rollback.release();}
    const [[afterRollback]]=await pool.execute("SELECT COUNT(*) total FROM telegram_notification_outbox WHERE chat_id=?",[chatId]);assert.equal(Number(afterRollback.total),0);
    const commit=await pool.getConnection();try{await commit.beginTransaction();await enqueueTelegramNotification({chatId,text:'must commit',executor:commit});await commit.commit();}finally{commit.release();}
    const [[afterCommit]]=await pool.execute("SELECT COUNT(*) total FROM telegram_notification_outbox WHERE chat_id=?",[chatId]);assert.equal(Number(afterCommit.total),1);
    const telegramId=String(790000000000n+(BigInt(Date.now())%100000000000n));let participantId,ticketId;
    const ticketNo='SUP-'+telegramId;
    try{
      const [participant]=await pool.execute('INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)',[telegramId,'Outbox Support Test','+989121234567','outbox_support_test']);participantId=participant.insertId;
      const rollbackTicket=await pool.getConnection();try{await rollbackTicket.beginTransaction();const [ticket]=await rollbackTicket.execute("INSERT INTO support_tickets(ticket_number,participant_id,category,subject,status) VALUES(?,?,? ,?,'new')",[ticketNo,participantId,'technical','Rollback ticket']);await rollbackTicket.execute("INSERT INTO support_messages(ticket_id,sender_type,sender_telegram_id,body) VALUES(?,'participant',?,?)",[ticket.insertId,telegramId,'rollback message']);await enqueueTelegramNotification({chatId,text:'ticket notice rollback',executor:rollbackTicket});await rollbackTicket.rollback();}finally{rollbackTicket.release();}
      const [[rolledBackTicket]]=await pool.execute('SELECT COUNT(*) total FROM support_tickets WHERE ticket_number=?',[ticketNo]);assert.equal(Number(rolledBackTicket.total),0);
      const [[rolledBackNotice]]=await pool.execute("SELECT COUNT(*) total FROM telegram_notification_outbox WHERE chat_id=? AND payload LIKE '%ticket notice rollback%'",[chatId]);assert.equal(Number(rolledBackNotice.total),0);
      const commitTicket=await pool.getConnection();try{await commitTicket.beginTransaction();const [ticket]=await commitTicket.execute("INSERT INTO support_tickets(ticket_number,participant_id,category,subject,status) VALUES(?,?,? ,?,'new')",[ticketNo,participantId,'technical','Committed ticket']);ticketId=ticket.insertId;await commitTicket.execute("INSERT INTO support_messages(ticket_id,sender_type,sender_telegram_id,body) VALUES(?,'participant',?,?)",[ticketId,telegramId,'committed message']);await enqueueTelegramNotification({chatId,text:'ticket notice commit',executor:commitTicket});await commitTicket.commit();}finally{commitTicket.release();}
      const [[committedTicket]]=await pool.execute('SELECT COUNT(*) total FROM support_tickets WHERE ticket_number=?',[ticketNo]);assert.equal(Number(committedTicket.total),1);
      const [[committedNotice]]=await pool.execute("SELECT COUNT(*) total FROM telegram_notification_outbox WHERE chat_id=? AND payload LIKE '%ticket notice commit%'",[chatId]);assert.equal(Number(committedNotice.total),1);
    }finally{if(ticketId)await pool.execute('DELETE FROM support_messages WHERE ticket_id=?',[ticketId]);if(participantId)await pool.execute('DELETE FROM support_tickets WHERE participant_id=?',[participantId]);if(participantId)await pool.execute('DELETE FROM participants WHERE id=?',[participantId]);await pool.execute('DELETE FROM telegram_notification_outbox WHERE chat_id=?',[chatId]);}
  }finally{await pool.execute('DELETE FROM telegram_notification_outbox WHERE chat_id=?',[chatId]);}
});

test.after(async()=>{if(enabled){const {pool}=await import('../../src/database/pool.js');await pool.end();}});


test('MySQL integration: campaign scheduler transitions use database UTC time consistently',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');const {migrate}=await import('../../src/database/migrate.js');
  const {processCampaignSchedule}=await import('../../src/modules/campaigns/campaign-scheduler.js');
  const suffix=String(Date.now());const ids=[];
  try{
    await migrate();
    const [a]=await pool.execute("INSERT INTO campaigns(slug,title,status,participation_type,starts_at,ends_at) VALUES(?,?,'scheduled','free',DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 MINUTE),DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 HOUR))",['schedule-start-'+suffix,'Schedule start']);
    ids.push(a.insertId);
    const [b]=await pool.execute("INSERT INTO campaigns(slug,title,status,participation_type,ends_at) VALUES(?,?,'open','free',DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 MINUTE))",['schedule-end-'+suffix,'Schedule end']);
    ids.push(b.insertId);
    const processed=await processCampaignSchedule();
    assert.ok(processed>=2);
    const [rows]=await pool.execute('SELECT id,status FROM campaigns WHERE id IN (?,?)',ids);
    assert.equal(rows.find(x=>Number(x.id)===Number(ids[0])).status,'open');
    assert.equal(rows.find(x=>Number(x.id)===Number(ids[1])).status,'closed');
  }finally{
    if(ids.length){await pool.execute('DELETE FROM campaigns WHERE id IN (?,?)',ids);}
  }
});

test('MySQL integration: outbox marks expired sending leases uncertain without duplicate send',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');const {migrate}=await import('../../src/database/migrate.js');
  const {processNotificationOutbox}=await import('../../src/modules/notifications/outbox.worker.js');
  const chatId=String(880000000000n+(BigInt(Date.now())%100000000000n));let id;
  try{
    await migrate();
    const [r]=await pool.execute("INSERT INTO telegram_notification_outbox(chat_id,payload,status,locked_at,lease_token) VALUES(?,JSON_OBJECT('text','must not auto resend'),'sending',DATE_SUB(UTC_TIMESTAMP(),INTERVAL 10 MINUTE),UUID())",[chatId]);id=r.insertId;
    let sends=0;const result=await processNotificationOutbox({sendMessage:async()=>{sends++;}});
    assert.equal(sends,0);assert.equal(result.claimed,0);
    const [[row]]=await pool.execute('SELECT status,lease_token,locked_at FROM telegram_notification_outbox WHERE id=?',[id]);
    assert.equal(row.status,'uncertain');assert.equal(row.lease_token,null);assert.equal(row.locked_at,null);
  }finally{if(id)await pool.execute('DELETE FROM telegram_notification_outbox WHERE id=?',[id]);}
});



test('MySQL integration: outbox stores safe delivery errors and audited manual retry requeues one uncertain notification',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');const {migrate}=await import('../../src/database/migrate.js');
  const {createNotificationOutboxWorker}=await import('../../src/modules/notifications/outbox.worker.js');
  const {retryOutboxNotification}=await import('../../src/modules/notifications/outbox-admin.service.js');
  const chatId=String(870000000000n+(BigInt(Date.now())%100000000000n));
  const secret='private phone +989121234567 receipt SECRET-OUTBOX';
  let id;
  const emitted=[];
  try{
    await migrate();
    const [[pending]]=await pool.execute("SELECT COUNT(*) total FROM telegram_notification_outbox WHERE status='pending' AND available_at<=UTC_TIMESTAMP()");
    assert.equal(Number(pending.total),0,'isolated integration DB must have no runnable outbox rows');
    const [inserted]=await pool.execute("INSERT INTO telegram_notification_outbox(chat_id,payload,status,available_at) VALUES(?,JSON_OBJECT('text','sanitized integration fixture'),'pending',UTC_TIMESTAMP())",[chatId]);
    id=inserted.insertId;
    const worker=createNotificationOutboxWorker({
      database:pool,
      log:{warn:data=>emitted.push(data),error:data=>emitted.push(data)},
      deliver:async()=>{throw new Error(secret);}
    });
    const result=await worker({}, {limit:1});
    assert.deepEqual(result,{claimed:1,delivered:0,failed:0,retried:0,uncertain:1});
    const [[uncertain]]=await pool.execute('SELECT status,attempts,last_error,lease_token,locked_at FROM telegram_notification_outbox WHERE id=?',[id]);
    assert.equal(uncertain.status,'uncertain');
    assert.equal(Number(uncertain.attempts),1);
    assert.equal(uncertain.last_error,'network_or_unknown');
    assert.equal(uncertain.lease_token,null);
    assert.equal(uncertain.locked_at,null);
    assert.equal(JSON.stringify(emitted).includes(secret),false);
    assert.equal(JSON.stringify(emitted).includes('989121234567'),false);
    assert.equal(JSON.stringify(emitted).includes('SECRET-OUTBOX'),false);

    await retryOutboxNotification({notificationId:id,adminId:'900000000001',expectedStatus:'uncertain',database:pool});
    const [[requeued]]=await pool.execute('SELECT status,attempts,manual_retry_count,last_error FROM telegram_notification_outbox WHERE id=?',[id]);
    assert.equal(requeued.status,'pending');
    assert.equal(Number(requeued.attempts),0);
    assert.equal(Number(requeued.manual_retry_count),1);
    assert.equal(requeued.last_error,'manually_requeued');
    const [[audit]]=await pool.execute("SELECT COUNT(*) total FROM admin_audit_log WHERE action='system.outbox_manual_retry' AND entity_type='notification_outbox' AND entity_id=?",[id]);
    assert.equal(Number(audit.total),1);
  }finally{if(id)await pool.execute('DELETE FROM telegram_notification_outbox WHERE id=?',[id]);}
});



test('MySQL integration: Telegram inbox persists only a fixed error label when a handler exception contains private data',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');const {migrate}=await import('../../src/database/migrate.js');
  const {createUpdateGuard}=await import('../../src/bot/middleware/update-guard.js');
  const updateId=Number(Date.now())*1000+791;
  const secret='participant phone +989121234567 receipt SECRET-INBOX-INTEGRATION';
  try{
    await migrate();
    const guard=createUpdateGuard({
      database:pool,
      log:{error(){},warn(){}},
      correlate:(_correlationId,run)=>run(),
      uuid:()=> 'inbox-test-lease-token'
    });
    const ctx={update:{update_id:updateId,message:{text:secret}},state:{}};
    await assert.rejects(guard(ctx,async()=>{throw new Error(secret);}),/participant phone/);
    const [[row]]=await pool.execute('SELECT status,last_error,payload FROM telegram_update_inbox WHERE update_id=?',[updateId]);
    assert.equal(row.status,'failed');
    assert.equal(row.last_error,'handler_failed');
    const payload=typeof row.payload==='string'?JSON.parse(row.payload):row.payload;
    assert.equal(payload.message.text,secret,'the inbox retains the original Telegram update payload under its separate retention policy');
    assert.equal(row.last_error.includes('989121234567'),false);
    assert.equal(row.last_error.includes('SECRET-INBOX-INTEGRATION'),false);
  }finally{await pool.execute('DELETE FROM telegram_update_inbox WHERE update_id=?',[updateId]);}
});


test('MySQL integration: bank cards support CRUD, a single active default, safe deactivation and order snapshot source',{skip:!enabled},async(t)=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {createPaymentCard,updatePaymentCard,setDefaultPaymentCard,setPaymentCardActive,getDefaultPaymentCard}=await import('../../src/modules/payments/bank-card.service.js');
  const suffix=String(Date.now()).slice(-12).padStart(12,'0');
  const cardA='4111'+suffix,cardB='5555'+suffix;
  let idA,idB;
  try{
    await migrate();
    const [[existing]]=await pool.execute('SELECT COUNT(*) AS total FROM payment_bank_cards');
    if(Number(existing.total)!==0){
      t.skip('Requires an empty disposable CI card table; refusing to modify pre-existing card records.');
      return;
    }
    const a=await createPaymentCard({bankName:'Integration Bank A',cardNumber:cardA,cardHolder:'Integration Holder A',instructions:'A'},'1');idA=a.id;
    const b=await createPaymentCard({bankName:'Integration Bank B',cardNumber:cardB,cardHolder:'Integration Holder B',instructions:'B'},'1');idB=b.id;
    await assert.rejects(createPaymentCard({bankName:'Duplicate Bank',cardNumber:cardA,cardHolder:'Duplicate Holder'},'1'),/قبلاً ثبت شده/);
    await setDefaultPaymentCard(idA,'1');
    await setDefaultPaymentCard(idB,'1');
    let current=await getDefaultPaymentCard();
    assert.equal(Number(current.id),idB);
    const [[defaultCount]]=await pool.execute('SELECT COUNT(*) total FROM payment_bank_cards WHERE is_default=1');
    assert.equal(Number(defaultCount.total),1);
    await setPaymentCardActive(idB,false,'1');
    current=await getDefaultPaymentCard();
    assert.ok(current,'Deactivating the default card must select another active card.');
    assert.notEqual(Number(current.id),idB,'The deactivated card must not remain the default.');
    const [[fallbackState]]=await pool.execute('SELECT is_active,is_default FROM payment_bank_cards WHERE id=?',[current.id]);
    assert.equal(Number(fallbackState.is_active),1);
    assert.equal(Number(fallbackState.is_default),1);
    const [[fallbackCount]]=await pool.execute('SELECT COUNT(*) total FROM payment_bank_cards WHERE is_active=1 AND is_default=1');
    assert.equal(Number(fallbackCount.total),1);
    await setPaymentCardActive(idB,true,'1');
    await setDefaultPaymentCard(idB,'1');
    const edited=await updatePaymentCard(idB,{bankName:'Updated Integration Bank',cardNumber:cardB,cardHolder:'Updated Integration Holder',instructions:'updated'},'1');
    assert.equal(edited.bank_name,'Updated Integration Bank');
    assert.equal(Number(edited.is_default),1);
    await setPaymentCardActive(idA,false,'1');
    await assert.rejects(setPaymentCardActive(idB,false,'1'),/ابتدا کارت دیگری اضافه/);
  }finally{
    if(idA)await pool.execute('DELETE FROM payment_bank_cards WHERE id=?',[idA]);
    if(idB)await pool.execute('DELETE FROM payment_bank_cards WHERE id=?',[idB]);
  }
});


test('MySQL integration: verifiable campaign draw snapshots eligible codes and reveals a committed seed',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';assert.match(db,/_ci$|_test$/);
  assert.match(String(process.env.DRAW_SEED_ENCRYPTION_KEY||''),/^[a-f0-9]{64}$/i);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {prepareCampaignDraw,completeCampaignDraw,verifyCampaignDraw}=await import('../../src/modules/draw/draw.service.js');
  const {getCampaignDrawProof}=await import('../../src/modules/draw/draw-proof.service.js');
  const {verifyDrawProof}=await import('../../src/modules/draw/draw-verifier.js');
  const suffix=String(Date.now());const telegramIds=[1,2].map(n=>String(660000000000n+BigInt(n)*10000000000n+(BigInt(Date.now())%1000000000n)));
  const participantIds=[];const entryIds=[];const codeIds=[];let campaignId,drawId;
  try{
    await migrate();
    for(let i=0;i<2;i++){
      const [p]=await pool.execute("INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)",[telegramIds[i],'Draw Test '+i,'+98912166666'+i,'draw_test_'+i]);
      participantIds.push(p.insertId);
    }
    const [campaign]=await pool.execute("INSERT INTO campaigns(slug,title,status,participation_type) VALUES(?,?,'closed','free')",['draw-it-'+suffix,'Draw integration']);
    campaignId=campaign.insertId;
    for(const participantId of participantIds){
      const [entry]=await pool.execute("INSERT INTO campaign_entries(campaign_id,participant_id,profile_snapshot,status) VALUES(?,?,JSON_OBJECT('test',true),'eligible')",[campaignId,participantId]);
      entryIds.push(entry.insertId);
    }
    const codeRows=[
      [entryIds[0],'P'+campaignId+'-ABCDE1-X0',1],
      [entryIds[0],'P'+campaignId+'-ABCD02-Y0',2],
      [entryIds[1],'P'+campaignId+'-ABCD03-Z0',3]
    ];
    for(const [entryId,code,sequence] of codeRows){
      const [created]=await pool.execute("INSERT INTO campaign_codes(campaign_entry_id,campaign_id,code,sequence_number,format_version,status) VALUES(?,?,?, ?,2,'active')",[entryId,campaignId,code,sequence]);
      codeIds.push(created.insertId);
    }
    const preparationAttempts=await Promise.allSettled([
      prepareCampaignDraw({campaignId,createdBy:telegramIds[0],winnerCount:2}),
      prepareCampaignDraw({campaignId,createdBy:telegramIds[1],winnerCount:2})
    ]);
    const preparedResults=preparationAttempts.filter(result=>result.status==='fulfilled');
    const rejectedPreparations=preparationAttempts.filter(result=>result.status==='rejected');
    assert.equal(preparedResults.length,1,'Concurrent preparation must create exactly one draw.');
    assert.equal(rejectedPreparations.length,1);
    assert.match(String(rejectedPreparations[0].reason?.message||''),/قبلاً/);
    const prepared=preparedResults[0].value;
    drawId=prepared.drawId;
    assert.equal(prepared.status,'prepared');assert.equal(prepared.candidateCount,3);assert.equal(prepared.winnerCount,2);
    assert.match(prepared.seedHash,/^[a-f0-9]{64}$/);
    await assert.rejects(completeCampaignDraw({drawId,completedBy:telegramIds[0]}),/پیش از اجرای قرعه‌کشی/);
    await pool.execute('UPDATE campaign_draws SET commitment_publication_reference=?,commitment_published_at=UTC_TIMESTAMP(),commitment_published_by=? WHERE id=?',['https://github.com/farjam2014/istore-lottery-bot/releases/tag/draw-'+drawId,telegramIds[0],drawId]);
    const [[before]]=await pool.execute('SELECT status,revealed_seed,seed_ciphertext,seed_key_id,candidate_snapshot_hash FROM campaign_draws WHERE id=?',[drawId]);
    assert.equal(before.status,'prepared');assert.equal(before.revealed_seed,null);assert.ok(before.seed_ciphertext);assert.equal(before.seed_key_id,'legacy-env');assert.equal(before.candidate_snapshot_hash,prepared.candidateSnapshotHash);
    await assert.rejects(prepareCampaignDraw({campaignId,createdBy:telegramIds[0],winnerCount:1}),/قبلاً/);
    const [[tamperTarget]]=await pool.execute('SELECT id,campaign_code_id,code_snapshot FROM draw_candidates WHERE draw_id=? ORDER BY id LIMIT 1',[drawId]);
    await assert.rejects(
      pool.execute("UPDATE draw_candidates SET code_snapshot='TAMPERED' WHERE id=?",[tamperTarget.id]),
      error=>error.code==='ER_NO_REFERENCED_ROW_2'
    ); // The database now prevents mutation of the code snapshot itself.
    await pool.execute("UPDATE campaign_codes SET status='revoked' WHERE id=?",[tamperTarget.campaign_code_id]);
    await assert.rejects(completeCampaignDraw({drawId,completedBy:telegramIds[0]}),/وضعیت یکی از کدها/);
    await pool.execute("UPDATE campaign_codes SET status='active' WHERE id=?",[tamperTarget.campaign_code_id]);
    const completionAttempts=await Promise.allSettled([
      completeCampaignDraw({drawId,completedBy:telegramIds[0]}),
      completeCampaignDraw({drawId,completedBy:telegramIds[1]})
    ]);
    const completedResults=completionAttempts.filter(result=>result.status==='fulfilled');
    const rejectedCompletions=completionAttempts.filter(result=>result.status==='rejected');
    assert.equal(completedResults.length,1,'Concurrent completion must commit exactly one winner set.');
    assert.equal(rejectedCompletions.length,1);
    assert.match(String(rejectedCompletions[0].reason?.message||''),/فقط قرعه‌کشی آماده/);
    const completed=completedResults[0].value;
    assert.equal(completed.status,'completed');assert.equal(completed.winners.length,2);
    assert.equal(createHash('sha256').update(completed.revealedSeed).digest('hex'),prepared.seedHash);
    assert.equal(new Set(completed.winners.map(x=>String(x.participantId))).size,2,'A participant must not win twice in one draw.');
    assert.equal(new Set(completed.winners.map(x=>x.code)).size,2);
    const [candidateProof]=await pool.execute('SELECT id,draw_id,campaign_id,campaign_code_id,participant_id,code_snapshot,candidate_hash FROM draw_candidates WHERE draw_id=?',[drawId]);
    const [winnerProof]=await pool.execute('SELECT campaign_code_id,participant_id,code_snapshot,rank_position FROM draw_winners WHERE draw_id=? ORDER BY rank_position',[drawId]);
    const proof=verifyCampaignDraw({drawId,algorithm:completed.algorithm,seed:completed.revealedSeed,seedHash:completed.seedHash,candidateSnapshotHash:completed.candidateSnapshotHash,candidates:candidateProof,winners:winnerProof});
    assert.equal(proof.valid,true,proof.reason||'Draw proof verification failed.');
    const exportedProof=await getCampaignDrawProof(drawId);
    const offlineResult=verifyDrawProof(exportedProof);
    assert.equal(offlineResult.valid,true,offlineResult.reason||'Exported offline proof verification failed.');
    assert.equal(exportedProof.candidates.length,3);
    assert.equal(exportedProof.winners.length,2);
    assert.equal(exportedProof.draw.publication.publishedBy,'admin');
    assert.equal(JSON.stringify(exportedProof).includes(telegramIds[0]),false,'Proof must not disclose the publishing administrator or participant Telegram ID.');
    assert.equal(Object.hasOwn(exportedProof.candidates[0],'phone'),false,'Proof must not contain participant contact data.');
    const [[drawState]]=await pool.execute('SELECT status,revealed_seed FROM campaign_draws WHERE id=?',[drawId]);
    assert.equal(drawState.status,'completed');assert.equal(drawState.revealed_seed,completed.revealedSeed);
    const [[campaignState]]=await pool.execute('SELECT status FROM campaigns WHERE id=?',[campaignId]);assert.equal(campaignState.status,'drawn');
    await assert.rejects(completeCampaignDraw({drawId,completedBy:telegramIds[0]}),/فقط قرعه‌کشی آماده/);
  }finally{
    if(drawId){await pool.execute('DELETE FROM draw_winners WHERE draw_id=?',[drawId]);await pool.execute('DELETE FROM draw_candidates WHERE draw_id=?',[drawId]);await pool.execute('DELETE FROM campaign_draws WHERE id=?',[drawId]);}
    if(codeIds.length)await pool.execute('DELETE FROM campaign_codes WHERE id IN ('+codeIds.map(()=>'?').join(',')+')',codeIds);
    if(entryIds.length)await pool.execute('DELETE FROM campaign_entries WHERE id IN ('+entryIds.map(()=>'?').join(',')+')',entryIds);
    if(campaignId)await pool.execute('DELETE FROM campaigns WHERE id=?',[campaignId]);
    if(participantIds.length)await pool.execute('DELETE FROM participants WHERE id IN ('+participantIds.map(()=>'?').join(',')+')',participantIds);
  }
});


test('MySQL integration: draw preparation respects configured draw_at',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/);
  assert.match(String(process.env.DRAW_SEED_ENCRYPTION_KEY||''),/^[a-f0-9]{64}$/i);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {prepareCampaignDraw}=await import('../../src/modules/draw/draw.service.js');
  let campaignId,participantId,entryId,codeId;
  const suffix=String(Date.now())+'-'+Math.random().toString(16).slice(2);
  const telegramId=String(640000000000n+(BigInt(Date.now())%100000000000n));
  try{
    await migrate();
    const [participant]=await pool.execute('INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)',[telegramId,'Future Draw Test','+989121777779','future_draw_'+suffix]);
    participantId=participant.insertId;
    const [campaign]=await pool.execute("INSERT INTO campaigns(slug,title,status,participation_type,draw_at) VALUES(?,?,'closed','free',DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 DAY))",['future-draw-'+suffix,'Future draw test']);
    campaignId=campaign.insertId;
    const [entry]=await pool.execute("INSERT INTO campaign_entries(campaign_id,participant_id,profile_snapshot,status) VALUES(?,?,JSON_OBJECT('test',true),'eligible')",[campaignId,participantId]);
    entryId=entry.insertId;
    const [code]=await pool.execute("INSERT INTO campaign_codes(campaign_entry_id,campaign_id,code,sequence_number,format_version,status) VALUES(?,?,?,1,2,'active')",[entryId,campaignId,'P'+campaignId+'-FUTURE1-X0']);
    codeId=code.insertId;
    await assert.rejects(prepareCampaignDraw({campaignId,createdBy:telegramId,winnerCount:1}),/زمان تعیین‌شده برای قرعه‌کشی هنوز نرسیده/);
    const [[drawCount]]=await pool.execute('SELECT COUNT(*) total FROM campaign_draws WHERE campaign_id=?',[campaignId]);
    assert.equal(Number(drawCount.total),0);
  }finally{
    if(campaignId){
      await pool.execute('DELETE FROM draw_winners WHERE campaign_id=?',[campaignId]);
      await pool.execute('DELETE FROM draw_candidates WHERE campaign_id=?',[campaignId]);
      await pool.execute('DELETE FROM campaign_draws WHERE campaign_id=?',[campaignId]);
      await pool.execute('DELETE FROM campaign_codes WHERE campaign_id=?',[campaignId]);
      await pool.execute('DELETE FROM campaign_entries WHERE campaign_id=?',[campaignId]);
      await pool.execute('DELETE FROM campaigns WHERE id=?',[campaignId]);
    }
    if(participantId)await pool.execute('DELETE FROM participants WHERE id=?',[participantId]);
  }
});

test('MySQL integration: draw preparation waits for first and repeat pending payments and rejects late approvals',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/);
  assert.match(String(process.env.DRAW_SEED_ENCRYPTION_KEY||''),/^[a-f0-9]{64}$/i);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {prepareCampaignDraw}=await import('../../src/modules/draw/draw.service.js');
  const {reviewReceipt}=await import('../../src/modules/payments/payment.service.js');
  const suffix=String(Date.now())+'-'+Math.random().toString(16).slice(2);
  const telegramIds=[1,2].map(n=>String(650000000000n+BigInt(n)*10000000000n+(BigInt(Date.now())%1000000000n)));
  const participantIds=[];
  let campaignId,eligibleEntryId,pendingEntryId,codeId,orderId,receiptId,repeatOrderId,repeatReceiptId,drawId;
  try{
    await migrate();
    for(let i=0;i<2;i++){
      const [p]=await pool.execute(
        'INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)',
        [telegramIds[i],'Draw Payment Race '+i,'+98912177777'+i,'draw_payment_race_'+suffix+'_'+i]
      );
      participantIds.push(p.insertId);
    }
    const [campaign]=await pool.execute(
      "INSERT INTO campaigns(slug,title,status,participation_type,entry_price,codes_per_entry) VALUES(?,?,'closed','paid',100000,2)",
      ['draw-payment-race-'+suffix,'Draw payment race']
    );
    campaignId=campaign.insertId;
    const [eligibleEntry]=await pool.execute(
      "INSERT INTO campaign_entries(campaign_id,participant_id,profile_snapshot,status) VALUES(?,?,JSON_OBJECT('test',true),'eligible')",
      [campaignId,participantIds[0]]
    );
    eligibleEntryId=eligibleEntry.insertId;
    const [pendingEntry]=await pool.execute(
      "INSERT INTO campaign_entries(campaign_id,participant_id,profile_snapshot,status) VALUES(?,?,JSON_OBJECT('test',true),'pending_payment')",
      [campaignId,participantIds[1]]
    );
    pendingEntryId=pendingEntry.insertId;
    const [code]=await pool.execute(
      "INSERT INTO campaign_codes(campaign_entry_id,campaign_id,code,sequence_number,format_version,status) VALUES(?,?,?,1,2,'active')",
      [eligibleEntryId,campaignId,'P'+campaignId+'-ABCDE1-X0']
    );
    codeId=code.insertId;
    const [order]=await pool.execute(
      "INSERT INTO payment_orders(campaign_entry_id,payment_reference,amount,requested_code_count,currency,status,expires_at) VALUES(?,?,100000,1,'IRR','under_review',DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 DAY))",
      [pendingEntryId,'ISTPAY-'+suffix.replace(/[^A-Z0-9]/gi,'').toUpperCase().slice(0,24)]
    );
    orderId=order.insertId;
    const [receipt]=await pool.execute(
      "INSERT INTO payment_receipts(order_id,telegram_file_id,telegram_file_unique_id,status) VALUES(?,?,?,'submitted')",
      [orderId,'draw-payment-file-'+suffix,'draw-payment-unique-'+suffix]
    );
    receiptId=receipt.insertId;
    const [repeatOrder]=await pool.execute(
      "INSERT INTO payment_orders(campaign_entry_id,payment_reference,amount,requested_code_count,currency,status,expires_at) VALUES(?,?,100000,1,'IRR','under_review',DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 DAY))",
      [eligibleEntryId,'ISTREP-'+suffix.replace(/[^A-Z0-9]/gi,'').toUpperCase().slice(0,20)]
    );
    repeatOrderId=repeatOrder.insertId;
    const [repeatReceipt]=await pool.execute(
      "INSERT INTO payment_receipts(order_id,telegram_file_id,telegram_file_unique_id,status) VALUES(?,?,?,'submitted')",
      [repeatOrderId,'draw-repeat-file-'+suffix,'draw-repeat-unique-'+suffix]
    );
    repeatReceiptId=repeatReceipt.insertId;

    const firstAttempt=await prepareCampaignDraw({campaignId,createdBy:telegramIds[0],winnerCount:1}).then(value=>({value}),error=>({error}));
    if(firstAttempt.value)drawId=firstAttempt.value.drawId;
    assert.match(String(firstAttempt.error?.message||''),/در انتظار پرداخت/);

    await pool.execute("UPDATE campaign_entries SET status='cancelled' WHERE id=?",[pendingEntryId]);
    await pool.execute("UPDATE payment_orders SET status='cancelled' WHERE id=?",[orderId]);
    const repeatAttempt=await prepareCampaignDraw({campaignId,createdBy:telegramIds[0],winnerCount:1}).then(value=>({value}),error=>({error}));
    if(repeatAttempt.value)drawId=repeatAttempt.value.drawId;
    assert.match(String(repeatAttempt.error?.message||''),/سفارش‌های پرداختی فعال/);
    await pool.execute("UPDATE payment_orders SET status='cancelled' WHERE id=?",[repeatOrderId]);
    const prepared=await prepareCampaignDraw({campaignId,createdBy:telegramIds[0],winnerCount:1});
    drawId=prepared.drawId;
    assert.equal(prepared.candidateCount,1);

    await pool.execute("UPDATE campaign_entries SET status='pending_payment' WHERE id=?",[pendingEntryId]);
    await pool.execute("UPDATE payment_orders SET status='under_review' WHERE id=?",[orderId]);
    await assert.rejects(
      reviewReceipt({adminId:'9001',receiptId,decision:'approve'}),
      /پس از آماده‌سازی یا تکمیل قرعه‌کشی/
    );
    const [[state]]=await pool.execute(
      "SELECT o.status order_status,pr.status receipt_status,(SELECT COUNT(*) FROM campaign_codes WHERE campaign_entry_id=?) code_count FROM payment_orders o JOIN payment_receipts pr ON pr.order_id=o.id WHERE o.id=? AND pr.id=?",
      [pendingEntryId,orderId,receiptId]
    );
    assert.equal(state.order_status,'under_review');
    assert.equal(state.receipt_status,'submitted');
    assert.equal(Number(state.code_count),0);
  }finally{
    if(drawId){
      await pool.execute('DELETE FROM draw_winners WHERE draw_id=?',[drawId]);
      await pool.execute('DELETE FROM draw_candidates WHERE draw_id=?',[drawId]);
      await pool.execute('DELETE FROM campaign_draws WHERE id=?',[drawId]);
    }
    if(orderId){
      await pool.execute('DELETE FROM payment_receipts WHERE order_id=?',[orderId]);
      await pool.execute('DELETE FROM payment_events WHERE order_id=?',[orderId]);
      await pool.execute('DELETE FROM payment_orders WHERE id=?',[orderId]);
    }
    if(repeatOrderId){
      await pool.execute('DELETE FROM payment_receipts WHERE order_id=?',[repeatOrderId]);
      await pool.execute('DELETE FROM payment_events WHERE order_id=?',[repeatOrderId]);
      await pool.execute('DELETE FROM payment_orders WHERE id=?',[repeatOrderId]);
    }
    if(campaignId){
      await pool.execute('DELETE FROM campaign_codes WHERE campaign_id=?',[campaignId]);
      await pool.execute('DELETE FROM campaign_entries WHERE campaign_id=?',[campaignId]);
      await pool.execute('DELETE FROM campaigns WHERE id=?',[campaignId]);
    }
    for(const id of participantIds)await pool.execute('DELETE FROM participants WHERE id=?',[id]);
  }
});

test('MySQL integration: production migration preflight executes only read-only statements',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {readFile}=await import('node:fs/promises');
  await migrate();
  const source=await readFile(new URL('../../scripts/production-migration-preflight.sql',import.meta.url),'utf8');
  const statements=source.split('\n').filter(line=>!line.trimStart().startsWith('--')).join('\n').split(';').map(statement=>statement.trim()).filter(Boolean);
  assert.ok(statements.length>=16,'Preflight must contain the expected inventory, capability guards, and integrity queries.');
  const connection=await pool.getConnection();
  try{
    for(const statement of statements){
      assert.match(statement,/^(?:SELECT|SET|PREPARE|EXECUTE|DEALLOCATE PREPARE)\b/i,'Production preflight may only read data and manage session-scoped prepared SELECT statements.');
      await connection.query(statement);
    }
  }finally{
    try{await connection.query('SET @preflight_sql=NULL,@has_candidate_campaign_id=NULL,@has_winner_campaign_id=NULL');}catch{}
    connection.release();
  }
});


test('MySQL integration: manually close campaigns without an end date for draw readiness',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {closeCampaign}=await import('../../src/modules/campaigns/campaign-admin.service.js');
  let campaignId;
  const slug='manual-close-'+Date.now();
  try{
    await migrate();
    const [campaign]=await pool.execute("INSERT INTO campaigns(slug,title,status,participation_type,ends_at) VALUES(?,?,'open','free',NULL)",[slug,'Manual close without end date']);
    campaignId=campaign.insertId;
    const result=await closeCampaign({campaignId,actorId:'9001'});
    assert.equal(result.from,'open');
    assert.equal(result.to,'closed');
    const [[closed]]=await pool.execute('SELECT status,ends_at FROM campaigns WHERE id=?',[campaignId]);
    assert.equal(closed.status,'closed');
    assert.equal(closed.ends_at,null);
    await assert.rejects(closeCampaign({campaignId,actorId:'9001'}),/بستن دستی فقط/);
  }finally{
    if(campaignId){
      
      await pool.execute('DELETE FROM campaigns WHERE id=?',[campaignId]);
    }
  }
});

test('MySQL integration: campaign archive requires eligible entries to be resolved and blocks prepared draws',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {archiveCampaign}=await import('../../src/modules/campaigns/campaign-admin.service.js');
  let campaignId,drawId,participantId,entryId,codeId,expiredOrderId;
  const slug='archive-draw-'+Date.now();
  const telegramId=String(690000000000000000n+(BigInt(Date.now())%1000000000n));
  try{
    await migrate();
    const [campaign]=await pool.execute("INSERT INTO campaigns(slug,title,status,participation_type) VALUES(?,?,'closed','free')",[slug,'Archive draw guard']);
    campaignId=campaign.insertId;
    const [participant]=await pool.execute('INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)',[telegramId,'Archive Eligible Participant','+989121234567','archive_test']);
    participantId=participant.insertId;
    const [entry]=await pool.execute("INSERT INTO campaign_entries(campaign_id,participant_id,profile_snapshot,status) VALUES(?,?,?,'eligible')",[campaignId,participantId,JSON.stringify({telegram_user_id:telegramId,full_name:'Archive Eligible Participant'})]);
    entryId=entry.insertId;
    const [code]=await pool.execute("INSERT INTO campaign_codes(campaign_entry_id,campaign_id,code,sequence_number,format_version,status) VALUES(?,?,?,1,2,'active')",[entryId,campaignId,'P'+campaignId+'-ARCH1-X0']);
    codeId=code.insertId;
    const [draw]=await pool.execute(
      "INSERT INTO campaign_draws(campaign_id,status,algorithm,seed_hash,candidate_count,created_by) VALUES(?,'prepared','legacy-test',?,0,'9001')",
      [campaignId,'a'.repeat(64)]
    );
    drawId=draw.insertId;
    await assert.rejects(archiveCampaign({campaignId,actorId:'9001'}),/قرعه‌کشی آماده یا تکمیل‌شده/);
    const [[unchanged]]=await pool.execute('SELECT status FROM campaigns WHERE id=?',[campaignId]);
    assert.equal(unchanged.status,'closed');
    await pool.execute("UPDATE campaign_draws SET status='cancelled' WHERE id=?",[drawId]);
    await assert.rejects(archiveCampaign({campaignId,actorId:'9001'}),/شرکت‌کنندگان واجد شرایط/);
    const [[stillClosed]]=await pool.execute('SELECT status FROM campaigns WHERE id=?',[campaignId]);
    assert.equal(stillClosed.status,'closed');
    await pool.execute("UPDATE participants SET status='blocked' WHERE id=?",[participantId]);
    const [expiredOrder]=await pool.execute("INSERT INTO payment_orders(campaign_entry_id,payment_reference,amount,currency,status,expires_at) VALUES(?,? ,100000,'IRR','rejected',DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 DAY))",[entryId,'ARCH-'+Date.now()]);
    expiredOrderId=expiredOrder.insertId;
    const archived=await archiveCampaign({campaignId,actorId:'9001'});
    assert.equal(archived.to,'archived');
    const [[updated]]=await pool.execute('SELECT status FROM campaigns WHERE id=?',[campaignId]);
    assert.equal(updated.status,'archived');
  }finally{
    if(drawId){await pool.execute('DELETE FROM draw_winners WHERE draw_id=?',[drawId]);await pool.execute('DELETE FROM draw_candidates WHERE draw_id=?',[drawId]);await pool.execute('DELETE FROM campaign_draws WHERE id=?',[drawId]);}
    if(expiredOrderId){await pool.execute('DELETE FROM payment_events WHERE order_id=?',[expiredOrderId]);await pool.execute('DELETE FROM payment_orders WHERE id=?',[expiredOrderId]);}
    if(entryId)await pool.execute('DELETE FROM campaign_codes WHERE campaign_entry_id=?',[entryId]);
    if(entryId)await pool.execute('DELETE FROM campaign_entries WHERE id=?',[entryId]);
    if(participantId)await pool.execute('DELETE FROM participants WHERE id=?',[participantId]);
    if(campaignId){
      
      await pool.execute('DELETE FROM campaigns WHERE id=?',[campaignId]);
    }
  }
});

test('MySQL integration: draw winner cannot reference a candidate with mismatched participant or entry',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const suffix=String(Date.now());
  const participants=[],entries=[],codes=[];
  let campaignId,drawId,candidateId;
  try{
    await migrate();
    for(let i=0;i<2;i++){
      const [p]=await pool.execute(
        'INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)',
        [String(640000000000n+BigInt(i)*10000000000n+(BigInt(Date.now())%1000000000n)),'Integrity '+i,'+9891218888'+i,'draw_integrity_'+suffix+'_'+i]
      );
      participants.push(p.insertId);
    }
    const [campaign]=await pool.execute(
      "INSERT INTO campaigns(slug,title,status,participation_type) VALUES(?,?,'closed','free')",
      ['draw-integrity-'+suffix,'Draw integrity FK']
    );
    campaignId=campaign.insertId;
    for(const participantId of participants){
      const [entry]=await pool.execute(
        "INSERT INTO campaign_entries(campaign_id,participant_id,profile_snapshot,status) VALUES(?,?,JSON_OBJECT('test',true),'eligible')",
        [campaignId,participantId]
      );
      entries.push(entry.insertId);
    }
    const codeValues=[];
    for(let i=0;i<2;i++){
      const [code]=await pool.execute(
        "INSERT INTO campaign_codes(campaign_entry_id,campaign_id,code,sequence_number,format_version,status) VALUES(?,?,?, ?,2,'active')",
        [entries[i],campaignId,'FK-'+suffix+'-'+i,i+1]
      );
      codes.push(code.insertId);codeValues.push('FK-'+suffix+'-'+i);
    }
    const [draw]=await pool.execute(
      "INSERT INTO campaign_draws(campaign_id,status,algorithm,seed_hash,candidate_count,created_by) VALUES(?,'prepared','test',?,2,'9001')",
      [campaignId,'a'.repeat(64)]
    );
    drawId=draw.insertId;
    const [candidate]=await pool.execute(
      'INSERT INTO draw_candidates(draw_id,campaign_id,campaign_code_id,campaign_entry_id,participant_id,code_snapshot,candidate_hash) VALUES(?,?,?,?,?,?,?)',
      [drawId,campaignId,codes[0],entries[0],participants[0],codeValues[0],'b'.repeat(64)]
    );
    candidateId=candidate.insertId;
    await assert.rejects(
      pool.execute(
        'INSERT INTO draw_winners(draw_id,campaign_id,campaign_code_id,participant_id,candidate_id,campaign_entry_id,code_snapshot,rank_position) VALUES(?,?,?,?,?,?,?,1)',
        [drawId,campaignId,codes[0],participants[1],candidateId,entries[0],codeValues[0]]
      ),
      error=>error.code==='ER_NO_REFERENCED_ROW_2'
    );
    await assert.rejects(
      pool.execute(
        'INSERT INTO draw_candidates(draw_id,campaign_id,campaign_code_id,campaign_entry_id,participant_id,code_snapshot,candidate_hash) VALUES(?,?,?,?,?,?,?)',
        [drawId,campaignId,codes[1],entries[1],participants[0],codeValues[1],'c'.repeat(64)]
      ),
      error=>error.code==='ER_NO_REFERENCED_ROW_2'
    );
    const {cleanupExpiredRetentionRows}=await import('../../src/modules/privacy/retention-cleanup.worker.js');
    const retentionUserId=String(697000000000000000n+(BigInt(Date.now())%1000000000n));
    const retentionUpdateId=Number(Date.now())*100;
    const retentionTables=['telegram_user_sessions','admin_wizards','payment_card_admin_sessions','payment_admin_sessions','admin_search_sessions','admin_role_sessions','support_sessions','profile_change_sessions','telegram_rate_limits'];
    try{
      await pool.execute("INSERT INTO telegram_user_sessions(telegram_user_id,step,payload,last_update_id,updated_at) VALUES(?,'awaiting_name',JSON_OBJECT('full_name','expired'),?,UTC_TIMESTAMP()-INTERVAL 2 DAY)",[retentionUserId,retentionUpdateId]);
      await pool.execute("INSERT INTO admin_wizards(telegram_user_id,step,payload,last_update_id,updated_at) VALUES(?,'title',JSON_OBJECT('title','expired'),?,UTC_TIMESTAMP()-INTERVAL 2 DAY)",[retentionUserId,retentionUpdateId]);
      await pool.execute("INSERT INTO payment_card_admin_sessions(telegram_user_id,step,payload,last_update_id,updated_at) VALUES(?,'bank_name',JSON_OBJECT(),?,UTC_TIMESTAMP()-INTERVAL 2 DAY)",[retentionUserId,retentionUpdateId]);
      await pool.execute("INSERT INTO payment_admin_sessions(telegram_user_id,step,created_at) VALUES(?,'search_order',UTC_TIMESTAMP()-INTERVAL 2 DAY)",[retentionUserId]);
      await pool.execute("INSERT INTO admin_search_sessions(telegram_user_id,step,query_text,last_update_id,created_at) VALUES(?,'participant','expired-private-search',?,UTC_TIMESTAMP()-INTERVAL 2 DAY)",[retentionUserId,retentionUpdateId]);
      await pool.execute("INSERT INTO admin_role_sessions(telegram_user_id,role,last_update_id,created_at) VALUES(?,'support_agent',?,UTC_TIMESTAMP()-INTERVAL 2 DAY)",[retentionUserId,retentionUpdateId]);
      await pool.execute("INSERT INTO support_sessions(telegram_user_id,step,category,last_update_id,updated_at) VALUES(?,'new_message','technical',?,UTC_TIMESTAMP()-INTERVAL 2 DAY)",[retentionUserId,retentionUpdateId]);
      await pool.execute("INSERT INTO profile_change_sessions(telegram_user_id,step,last_update_id,created_at) VALUES(?,'full_name',?,UTC_TIMESTAMP()-INTERVAL 2 DAY)",[retentionUserId,retentionUpdateId]);
      await pool.execute("INSERT INTO processed_updates(update_id,processed_at) VALUES(?,UTC_TIMESTAMP()-INTERVAL 4 DAY)",[retentionUpdateId]);
      await pool.execute("INSERT INTO telegram_rate_limits(telegram_user_id,bucket,window_started_at,request_count) VALUES(?,'retention_test',UTC_TIMESTAMP()-INTERVAL 2 DAY,1)",[retentionUserId]);
      const result=await cleanupExpiredRetentionRows();
      assert.ok(result.deleted>=10,'retention worker must delete all ten seeded expired rows');
      for(const table of retentionTables){
        const [[remaining]]=await pool.execute('SELECT COUNT(*) AS total FROM '+table+' WHERE telegram_user_id=?',[retentionUserId]);
        assert.equal(Number(remaining.total),0,'Expired session rows must be removed from '+table);
      }
      const [[remainingProcessed]]=await pool.execute('SELECT COUNT(*) AS total FROM processed_updates WHERE update_id=?',[retentionUpdateId]);
      assert.equal(Number(remainingProcessed.total),0,'Expired processed update metadata must be removed');
    }finally{
      for(const table of retentionTables)await pool.execute('DELETE FROM '+table+' WHERE telegram_user_id=?',[retentionUserId]);
      await pool.execute('DELETE FROM processed_updates WHERE update_id=?',[retentionUpdateId]);
    }
  }finally{
    if(drawId){
      await pool.execute('DELETE FROM draw_winners WHERE draw_id=?',[drawId]);
      await pool.execute('DELETE FROM draw_candidates WHERE draw_id=?',[drawId]);
      await pool.execute('DELETE FROM campaign_draws WHERE id=?',[drawId]);
    }
    if(codes.length)await pool.execute('DELETE FROM campaign_codes WHERE id IN ('+codes.map(()=>'?').join(',')+')',codes);
    if(entries.length)await pool.execute('DELETE FROM campaign_entries WHERE id IN ('+entries.map(()=>'?').join(',')+')',entries);
    if(campaignId)await pool.execute('DELETE FROM campaigns WHERE id=?',[campaignId]);
    if(participants.length)await pool.execute('DELETE FROM participants WHERE id IN ('+participants.map(()=>'?').join(',')+')',participants);
  }
});
