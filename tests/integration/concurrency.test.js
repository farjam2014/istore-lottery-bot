import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const enabled=process.env.RUN_MYSQL_TESTS==='1';

test('MySQL integration: concurrent campaign confirmations create and audit exactly one campaign',{skip:!enabled},async()=>{
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {createCampaignFromWizard}=await import('../../src/modules/campaigns/campaign-admin.service.js');
  await migrate();
  const telegramId=String(7300000000000n+(BigInt(Date.now())%100000000000n));
  const title='Concurrent Campaign '+telegramId;
  let campaignId=null;
  try{
    const payload={type:'free',title,description:'Concurrency integration test',codes:2,capacity:null,starts_at:null,ends_at:null,draw_at:null,prizeValue:null};
    await pool.execute('INSERT INTO admin_wizards(telegram_user_id,step,payload) VALUES(?,?,?)',[telegramId,'confirm',JSON.stringify(payload)]);
    const results=await Promise.allSettled([
      createCampaignFromWizard({telegramUserId:telegramId,actorId:telegramId}),
      createCampaignFromWizard({telegramUserId:telegramId,actorId:telegramId})
    ]);
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1,'Exactly one concurrent confirmation must succeed.');
    const winner=results.find(x=>x.status==='fulfilled').value;
    campaignId=winner.campaignId;
    const [[campaignCount]]=await pool.execute('SELECT COUNT(*) total FROM campaigns WHERE title=?',[title]);
    const [[auditCount]]=await pool.execute("SELECT COUNT(*) total FROM admin_audit_log WHERE action='campaign.created' AND entity_id=?",[campaignId]);
    assert.equal(Number(campaignCount.total),1);
    assert.equal(Number(auditCount.total),1);
  }finally{
    await pool.execute('DELETE FROM admin_wizards WHERE telegram_user_id=?',[telegramId]);
    if(campaignId){await pool.execute("DELETE FROM admin_audit_log WHERE entity_type='campaign' AND entity_id=?",[campaignId]);await pool.execute('DELETE FROM campaigns WHERE id=?',[campaignId]);}
    await pool.end();
  }
});

test('MySQL integration: repeated campaign-copy callbacks share one idempotent result',{skip:!enabled},async()=>{
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {copyCampaign}=await import('../../src/modules/campaigns/campaign-admin.service.js');
  await migrate();
  const actorId=String(7310000000000n+(BigInt(Date.now())%100000000000n));
  const slug='copy-idempotency-'+actorId;
  const key=createHash('sha256').update('campaign-copy-'+actorId).digest('hex');
  let sourceId=null,copyId=null;
  try{
    const [source]=await pool.execute("INSERT INTO campaigns(slug,title,status,participation_type,codes_per_entry) VALUES(?,?,'draft','free',1)",[slug,'Copy Source '+actorId]);
    sourceId=source.insertId;
    const results=await Promise.all([
      copyCampaign({campaignId:sourceId,actorId,idempotencyKey:key}),
      copyCampaign({campaignId:sourceId,actorId,idempotencyKey:key})
    ]);
    assert.equal(results[0].campaignId,results[1].campaignId);
    assert.equal(results.filter(x=>x.alreadyProcessed===false).length,1);
    assert.equal(results.filter(x=>x.alreadyProcessed===true).length,1);
    copyId=results[0].campaignId;
    const [[copyCount]]=await pool.execute('SELECT COUNT(*) total FROM campaigns WHERE id=?',[copyId]);
    assert.equal(Number(copyCount.total),1);
  }finally{
    if(copyId){await pool.execute("DELETE FROM admin_audit_log WHERE entity_type='campaign' AND entity_id=?",[copyId]);await pool.execute('DELETE FROM campaigns WHERE id=?',[copyId]);}
    if(sourceId)await pool.execute('DELETE FROM campaigns WHERE id=?',[sourceId]);
    await pool.execute('DELETE FROM admin_action_idempotency WHERE idempotency_key=?',[key]);
    await pool.end();
  }
});

test('MySQL integration: support session is consumed once after concurrent readers observe it',{skip:!enabled},async()=>{
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  await migrate();
  const telegramId=String(7320000000000n+(BigInt(Date.now())%100000000000n));
  let participantId=null,ticketId=null;
  try{
    const [participant]=await pool.execute('INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)',[telegramId,'Support Concurrency','+989121345678','support_concurrency']);
    participantId=participant.insertId;
    await pool.execute("INSERT INTO support_sessions(telegram_user_id,step,category) VALUES(?,'new_message','technical')",[telegramId]);
    let readers=0,releaseReaders;
    const bothObserved=new Promise(resolve=>{releaseReaders=resolve;});
    async function attemptCreateTicket(body){
      const [[observed]]=await pool.execute('SELECT step,category FROM support_sessions WHERE telegram_user_id=?',[telegramId]);
      if(!observed)return null;
      readers++;if(readers===2)releaseReaders();await bothObserved;
      const connection=await pool.getConnection();
      try{
        await connection.beginTransaction();
        const [[session]]=await connection.execute('SELECT step,category FROM support_sessions WHERE telegram_user_id=? FOR UPDATE',[telegramId]);
        if(!session||session.step!=='new_message'){await connection.commit();return null;}
        const ticketNumber='SUP-CI-'+telegramId;
        const [ticket]=await connection.execute("INSERT INTO support_tickets(ticket_number,participant_id,category,subject,status) VALUES(?,?,?,?,'new')",[ticketNumber,participantId,session.category,body.slice(0,180)]);
        await connection.execute("INSERT INTO support_messages(ticket_id,sender_type,sender_telegram_id,body) VALUES(?,'participant',?,?)",[ticket.insertId,telegramId,body]);
        await connection.execute('DELETE FROM support_sessions WHERE telegram_user_id=?',[telegramId]);
        await connection.commit();return ticket.insertId;
      }catch(error){await connection.rollback();throw error;}finally{connection.release();}
    }
    const results=await Promise.all([attemptCreateTicket('first concurrent message'),attemptCreateTicket('second concurrent message')]);
    assert.equal(results.filter(Boolean).length,1,'Only one request may consume the one-shot support session.');
    ticketId=results.find(Boolean);
    const [[ticketCount]]=await pool.execute('SELECT COUNT(*) total FROM support_tickets WHERE participant_id=?',[participantId]);
    const [[messageCount]]=await pool.execute('SELECT COUNT(*) total FROM support_messages WHERE ticket_id=?',[ticketId]);
    assert.equal(Number(ticketCount.total),1);
    assert.equal(Number(messageCount.total),1);
  }finally{
    await pool.execute('DELETE FROM support_sessions WHERE telegram_user_id=?',[telegramId]);
    if(ticketId){await pool.execute('DELETE FROM support_messages WHERE ticket_id=?',[ticketId]);await pool.execute('DELETE FROM support_tickets WHERE id=?',[ticketId]);}
    if(participantId)await pool.execute('DELETE FROM participants WHERE id=?',[participantId]);
    await pool.end();
  }
});
