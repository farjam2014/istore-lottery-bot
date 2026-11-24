import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const enabled=process.env.RUN_MYSQL_TESTS==='1';
after(async()=>{if(enabled){const {pool}=await import('../../src/database/pool.js');await pool.end();}});

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
    const [createdRows]=await pool.execute('SELECT id FROM campaigns WHERE title=?',[title]);
    for(const row of createdRows){await pool.execute("DELETE FROM admin_audit_log WHERE entity_type='campaign' AND entity_id=?",[row.id]);await pool.execute('DELETE FROM campaigns WHERE id=?',[row.id]);}
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
    const [copies]=await pool.execute('SELECT id FROM campaigns WHERE title=?',[`Copy Source ${actorId} (نسخه کپی)`]);
    for(const row of copies){await pool.execute("DELETE FROM admin_audit_log WHERE entity_type='campaign' AND entity_id=?",[row.id]);await pool.execute('DELETE FROM campaigns WHERE id=?',[row.id]);}
    if(sourceId)await pool.execute('DELETE FROM campaigns WHERE id=?',[sourceId]);
    await pool.execute('DELETE FROM admin_action_idempotency WHERE idempotency_key=?',[key]);
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
    if(participantId){await pool.execute('DELETE FROM support_messages WHERE ticket_id IN (SELECT id FROM support_tickets WHERE participant_id=?)',[participantId]);await pool.execute('DELETE FROM support_tickets WHERE participant_id=?',[participantId]);await pool.execute('DELETE FROM participants WHERE id=?',[participantId]);}
  }
});

test('MySQL integration: campaign edit wizard is consumed once under concurrent messages',{skip:!enabled},async()=>{
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  await migrate();
  const actorId=String(7330000000000n+(BigInt(Date.now())%100000000000n));
  const slug='edit-wizard-'+actorId;
  let campaignId=null;
  try{
    const [created]=await pool.execute("INSERT INTO campaigns(slug,title,status,participation_type,codes_per_entry) VALUES(?,?,'draft','free',1)",[slug,'Edit Wizard '+actorId]);
    campaignId=created.insertId;
    await pool.execute('INSERT INTO admin_wizards(telegram_user_id,step,payload) VALUES(?,?,?)',[actorId,'campaign_edit_value',JSON.stringify({campaignId,field:'title'})]);
    let readers=0,releaseReaders;
    const bothObserved=new Promise(resolve=>{releaseReaders=resolve;});
    async function attemptEdit(title){
      const [[observed]]=await pool.execute('SELECT step,payload FROM admin_wizards WHERE telegram_user_id=?',[actorId]);
      if(!observed)return false;
      readers++;if(readers===2)releaseReaders();await bothObserved;
      const connection=await pool.getConnection();
      try{
        await connection.beginTransaction();
        const [[wizard]]=await connection.execute('SELECT step,payload FROM admin_wizards WHERE telegram_user_id=? FOR UPDATE',[actorId]);
        const payload=wizard?(typeof wizard.payload==='string'?JSON.parse(wizard.payload):wizard.payload):null;
        if(!wizard||wizard.step!=='campaign_edit_value'||Number(payload?.campaignId)!==campaignId||payload?.field!=='title')throw new Error('Wizard changed.');
        const [[campaign]]=await connection.execute('SELECT status FROM campaigns WHERE id=? FOR UPDATE',[campaignId]);
        if(!campaign||campaign.status!=='draft')throw new Error('Campaign not editable.');
        await connection.execute('UPDATE campaigns SET title=? WHERE id=?',[title,campaignId]);
        await connection.execute('INSERT INTO admin_audit_log(admin_telegram_id,correlation_id,action,entity_type,entity_id,details) VALUES(?,NULL,?,?,?,?)',[actorId,'campaign.field_updated','campaign',campaignId,JSON.stringify({field:'title'})]);
        await connection.execute('DELETE FROM admin_wizards WHERE telegram_user_id=?',[actorId]);
        await connection.commit();return true;
      }catch(error){await connection.rollback();throw error;}finally{connection.release();}
    }
    const results=await Promise.allSettled([attemptEdit('Edit Winner A '+actorId),attemptEdit('Edit Winner B '+actorId)]);
    assert.equal(results.filter(x=>x.status==='fulfilled'&&x.value===true).length,1);
    assert.equal(results.filter(x=>x.status==='rejected').length,1);
    const [[auditCount]]=await pool.execute("SELECT COUNT(*) total FROM admin_audit_log WHERE action='campaign.field_updated' AND entity_id=?",[campaignId]);
    assert.equal(Number(auditCount.total),1);
  }finally{
    await pool.execute('DELETE FROM admin_wizards WHERE telegram_user_id=?',[actorId]);
    if(campaignId){await pool.execute("DELETE FROM admin_audit_log WHERE entity_type='campaign' AND entity_id=?",[campaignId]);await pool.execute('DELETE FROM campaigns WHERE id=?',[campaignId]);}
  }
});

test('MySQL integration: draw publication wizard update and audit are atomic under replay',{skip:!enabled},async()=>{
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  await migrate();
  const actorId=String(7340000000000n+(BigInt(Date.now())%100000000000n));
  const slug='draw-publish-'+actorId;
  let campaignId=null,drawId=null;
  try{
    const [campaign]=await pool.execute("INSERT INTO campaigns(slug,title,status,participation_type,codes_per_entry) VALUES(?,?,'draft','free',1)",[slug,'Draw Publish '+actorId]);
    campaignId=campaign.insertId;
    const [draw]=await pool.execute("INSERT INTO campaign_draws(campaign_id,status,algorithm,seed_hash,candidate_count,created_by) VALUES(?,'prepared','hmac-sha256-v1','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1,?)",[campaignId,actorId]);
    drawId=draw.insertId;
    await pool.execute('INSERT INTO admin_wizards(telegram_user_id,step,payload) VALUES(?,?,?)',[actorId,'draw_publication_confirm',JSON.stringify({drawId,reference:'https://proof.example.org/draw/'+drawId})]);
    let readers=0,releaseReaders;
    const bothObserved=new Promise(resolve=>{releaseReaders=resolve;});
    async function attemptPublish(){
      const [[observed]]=await pool.execute('SELECT step,payload FROM admin_wizards WHERE telegram_user_id=?',[actorId]);
      if(!observed)return false;
      readers++;if(readers===2)releaseReaders();await bothObserved;
      const connection=await pool.getConnection();
      try{
        await connection.beginTransaction();
        const [[wizard]]=await connection.execute('SELECT step,payload FROM admin_wizards WHERE telegram_user_id=? FOR UPDATE',[actorId]);
        const payload=wizard?(typeof wizard.payload==='string'?JSON.parse(wizard.payload):wizard.payload):null;
        if(!wizard||wizard.step!=='draw_publication_confirm'||Number(payload?.drawId)!==drawId)throw new Error('Wizard changed.');
        const [[lockedDraw]]=await connection.execute('SELECT campaign_id,status,commitment_published_at FROM campaign_draws WHERE id=? FOR UPDATE',[drawId]);
        if(!lockedDraw||lockedDraw.status!=='prepared'||lockedDraw.commitment_published_at)throw new Error('Draw not publishable.');
        const [updated]=await connection.execute("UPDATE campaign_draws SET commitment_publication_reference=?,commitment_published_at=UTC_TIMESTAMP(),commitment_published_by=? WHERE id=? AND status='prepared' AND commitment_published_at IS NULL",[payload.reference,actorId,drawId]);
        if(!updated.affectedRows)throw new Error('Draw already published.');
        await connection.execute('INSERT INTO admin_audit_log(admin_telegram_id,correlation_id,action,entity_type,entity_id,details) VALUES(?,NULL,?,?,?,?)',[actorId,'draw.commitment_published','campaign_draw',drawId,JSON.stringify({reference:payload.reference})]);
        await connection.execute('DELETE FROM admin_wizards WHERE telegram_user_id=?',[actorId]);
        await connection.commit();return true;
      }catch(error){await connection.rollback();throw error;}finally{connection.release();}
    }
    const results=await Promise.allSettled([
      attemptPublish(),
      attemptPublish()
    ]);
    assert.equal(results.filter(x=>x.status==='fulfilled'&&x.value===true).length,1);
    assert.equal(results.filter(x=>x.status==='rejected').length,1);
    const [[published]]=await pool.execute('SELECT commitment_publication_reference FROM campaign_draws WHERE id=?',[drawId]);
    assert.equal(published.commitment_publication_reference,'https://proof.example.org/draw/'+drawId);
    const [[auditCount]]=await pool.execute("SELECT COUNT(*) total FROM admin_audit_log WHERE action='draw.commitment_published' AND entity_id=?",[drawId]);
    assert.equal(Number(auditCount.total),1);
  }finally{
    await pool.execute('DELETE FROM admin_wizards WHERE telegram_user_id=?',[actorId]);
    if(drawId){await pool.execute("DELETE FROM admin_audit_log WHERE entity_type='campaign_draw' AND entity_id=?",[drawId]);await pool.execute('DELETE FROM campaign_draws WHERE id=?',[drawId]);}
    if(campaignId)await pool.execute('DELETE FROM campaigns WHERE id=?',[campaignId]);
  }
});
