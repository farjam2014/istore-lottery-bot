import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createConnection} from 'mysql2/promise';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const enabled=process.env.RUN_MYSQL_TESTS==='1';
const here=path.dirname(fileURLToPath(import.meta.url));
const splitSql=sql=>sql.split(/;\s*(?:\n|$)/).map(statement=>statement.trim()).filter(Boolean);

test('MySQL migration recovery: approved test-data cleanup is retry-safe and preserves master data',{skip:!enabled},async()=>{
  assert.match(process.env.MYSQL_DATABASE||'',/(?:_ci|_test)$/,'Integration tests must run only with an isolated _ci or _test database configured.');
  const host=process.env.MYSQL_HOST||'127.0.0.1';
  const port=Number(process.env.MYSQL_PORT||3306);
  const user=process.env.MYSQL_USER||'root';
  const password=process.env.MYSQL_PASSWORD||'';
  const database='istore_migration_recovery_'+process.pid+'_'+Date.now()+'_test';
  const connection=await createConnection({host,port,user,password,multipleStatements:false});
  try{
    await connection.query('CREATE DATABASE `'+database+'` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    await connection.changeUser({database});
    const schema=await readFile(path.join(here,'../../src/database/schema.sql'),'utf8');
    for(const statement of splitSql(schema))await connection.query(statement);

    const suffix=String(Date.now());
    const [campaign]=await connection.execute(
      "INSERT INTO campaigns(slug,title,status,participation_type) VALUES(?,?,'open','free')",
      ['migration-recovery-'+suffix,'Migration recovery campaign']
    );
    const [participant]=await connection.execute(
      'INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)',
      [String(910000000000n+BigInt(process.pid)),'Preserved Profile','+989121234567','preserved_profile']
    );
    const [entry]=await connection.execute(
      "INSERT INTO campaign_entries(campaign_id,participant_id,profile_snapshot,status) VALUES(?,?,JSON_OBJECT('full_name','Preserved Profile'),'eligible')",
      [campaign.insertId,participant.insertId]
    );
    const [code]=await connection.execute(
      'INSERT INTO campaign_codes(campaign_entry_id,campaign_id,code) VALUES(?,?,?)',
      [entry.insertId,campaign.insertId,'OLD-TEST-CODE']
    );
    const [order]=await connection.execute(
      "INSERT INTO payment_orders(campaign_entry_id,amount,status) VALUES(?,100000,'awaiting_receipt')",
      [entry.insertId]
    );
    const [receipt]=await connection.execute(
      'INSERT INTO payment_receipts(order_id,telegram_file_id,telegram_file_unique_id) VALUES(?,?,?)',
      [order.insertId,'migration-test-file','migration-test-receipt-'+suffix]
    );
    await connection.execute(
      "INSERT INTO payment_events(order_id,actor_telegram_id,event_type,details) VALUES(?,?,?,JSON_OBJECT('test',true))",
      [order.insertId,'1','receipt_submitted']
    );
    const [draw]=await connection.execute(
      "INSERT INTO campaign_draws(campaign_id,status,algorithm,seed_hash,candidate_count,created_by) VALUES(?,'prepared','test',?,1,1)",
      [campaign.insertId,'0'.repeat(64)]
    );
    await connection.execute(
      'INSERT INTO draw_candidates(draw_id,campaign_code_id,candidate_hash) VALUES(?,?,?)',
      [draw.insertId,code.insertId,'1'.repeat(64)]
    );
    await connection.execute(
      'INSERT INTO draw_winners(draw_id,campaign_code_id,rank_position) VALUES(?,?,1)',
      [draw.insertId,code.insertId]
    );

    const migration=await readFile(path.join(here,'../../src/database/migrations/20261116_001_campaign_code_format.sql'),'utf8');
    const statements=splitSql(migration);
    const createCounterIndex=statements.findIndex(statement=>/^CREATE TABLE IF NOT EXISTS campaign_code_counters/i.test(statement));
    assert.ok(createCounterIndex>=0,'Counter table creation statement must exist');

    // Simulate a process crash after the new column and unique index exist,
    // and after the counter table is created, but before counters are seeded
    // and before schema_migrations can record this migration.
    for(const statement of statements.slice(0,createCounterIndex+1))await connection.query(statement);

    const [[partialColumn]]=await connection.execute(
      "SELECT COUNT(*) total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='campaign_codes' AND COLUMN_NAME='sequence_number'"
    );
    assert.equal(Number(partialColumn.total),1);
    const [[partialIndex]]=await connection.execute(
      "SELECT COUNT(DISTINCT INDEX_NAME) total FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='campaign_codes' AND INDEX_NAME='uq_campaign_code_sequence'"
    );
    assert.equal(Number(partialIndex.total),1);
    const [[partialCounter]]=await connection.execute(
      'SELECT COUNT(*) total FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=\'campaign_code_counters\''
    );
    assert.equal(Number(partialCounter.total),1);

    // Retry the full migration from the beginning, as migrate() does when
    // the failed attempt never inserted its schema_migrations record.
    for(const statement of statements)await connection.query(statement);

    const [[campaignStillThere]]=await connection.execute('SELECT status FROM campaigns WHERE id=?',[campaign.insertId]);
    assert.equal(campaignStillThere.status,'open');
    const [[profileStillThere]]=await connection.execute('SELECT full_name FROM participants WHERE id=?',[participant.insertId]);
    assert.equal(profileStillThere.full_name,'Preserved Profile');
    const [[entriesAfterCleanup]]=await connection.execute('SELECT COUNT(*) total FROM campaign_entries WHERE campaign_id=?',[campaign.insertId]);
    assert.equal(Number(entriesAfterCleanup.total),0);
    const [[codesAfterCleanup]]=await connection.execute('SELECT COUNT(*) total FROM campaign_codes WHERE campaign_id=?',[campaign.insertId]);
    assert.equal(Number(codesAfterCleanup.total),0);
    for(const [table,column,value] of [
      ['payment_orders','campaign_entry_id',entry.insertId],
      ['payment_receipts','order_id',order.insertId],
      ['payment_events','order_id',order.insertId],
      ['campaign_draws','id',draw.insertId],
      ['draw_candidates','draw_id',draw.insertId],
      ['draw_winners','draw_id',draw.insertId]
    ]){
      const [[row]]=await connection.execute(`SELECT COUNT(*) total FROM ${table} WHERE ${column}=?`,[value]);
      assert.equal(Number(row.total),0,`Expected approved test cleanup to clear ${table}`);
    }
    const [[seededCounter]]=await connection.execute('SELECT next_sequence_number FROM campaign_code_counters WHERE campaign_id=?',[campaign.insertId]);
    assert.equal(Number(seededCounter.next_sequence_number),10001);

    await connection.execute('UPDATE campaign_code_counters SET next_sequence_number=10005 WHERE campaign_id=?',[campaign.insertId]);
    for(const statement of statements)await connection.query(statement);
    const [[counterAfterSecondRetry]]=await connection.execute('SELECT next_sequence_number FROM campaign_code_counters WHERE campaign_id=?',[campaign.insertId]);
    assert.equal(Number(counterAfterSecondRetry.next_sequence_number),10005,'A retry must never reset an existing counter');
  }finally{
    try{await connection.changeUser({database:'mysql'});await connection.query('DROP DATABASE IF EXISTS `'+database+'`');}catch{}
    await connection.end();
  }
});
