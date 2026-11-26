import test from 'node:test';
import assert from 'node:assert/strict';
import {createNotificationOutboxWorker} from '../../src/modules/notifications/outbox.worker.js';

function fakeDatabase(initialJobs=[]){
  const jobs=initialJobs.map(job=>({...job}));
  const database={
    jobs,
    async getConnection(){
      return {
        async beginTransaction(){},
        async commit(){},
        async rollback(){},
        release(){},
        execute:(sql,params)=>database.execute(sql,params)
      };
    },
    async execute(sql,params=[]){
      if(sql.startsWith("UPDATE telegram_notification_outbox SET status='uncertain'")){
        let affectedRows=0;
        for(const job of jobs){
          if(job.status==='sending'&&job.stale){
            job.status='uncertain';job.lease_token=null;job.locked_at=null;affectedRows++;
          }
        }
        return [{affectedRows},[]];
      }
      if(sql.startsWith('SELECT id,chat_id,payload,attempts,correlation_id')){
        return [jobs.filter(job=>job.status==='pending').map(({id,chat_id,payload,attempts,correlation_id})=>({id,chat_id,payload,attempts,correlation_id})),[]];
      }
      if(sql.startsWith("UPDATE telegram_notification_outbox SET status='sending'")){
        const [leaseToken,id]=params;
        const job=jobs.find(item=>item.id===id&&item.status==='pending');
        if(!job)return [{affectedRows:0},[]];
        job.status='sending';job.lease_token=leaseToken;job.attempts=Number(job.attempts||0)+1;
        return [{affectedRows:1},[]];
      }
      if(sql.startsWith("UPDATE telegram_notification_outbox SET status='failed'")){
        const [error,id,leaseToken]=params;
        const job=jobs.find(item=>item.id===id&&item.lease_token===leaseToken&&item.status==='sending');
        if(!job)return [{affectedRows:0},[]];
        job.status='failed';job.last_error=error;job.lease_token=null;job.locked_at=null;
        return [{affectedRows:1},[]];
      }
      if(sql.startsWith('UPDATE telegram_notification_outbox SET status=?')){
        const [status,delay,error,id,leaseToken]=params;
        const job=jobs.find(item=>item.id===id&&item.lease_token===leaseToken&&item.status==='sending');
        if(!job)return [{affectedRows:0},[]];
        job.status=status;job.retry_delay=delay;job.last_error=error;job.lease_token=null;job.locked_at=null;
        return [{affectedRows:1},[]];
      }
      if(sql.startsWith("UPDATE telegram_notification_outbox SET status='sent'")){
        const [id,leaseToken]=params;
        const job=jobs.find(item=>item.id===id&&item.lease_token===leaseToken&&item.status==='sending');
        if(!job)return [{affectedRows:0},[]];
        job.status='sent';job.lease_token=null;job.locked_at=null;
        return [{affectedRows:1},[]];
      }
      throw new Error('Unexpected SQL in outbox unit test: '+sql);
    }
  };
  return database;
}

const logger={warn(){},error(){}};
const job=(overrides={})=>({
  id:1,chat_id:'12345',payload:{text:'hello'},attempts:0,correlation_id:'corr-1',status:'pending',...overrides
});

test('outbox worker sends a valid notification and marks it sent',async()=>{
  const database=fakeDatabase([job()]);
  const sent=[];
  const worker=createNotificationOutboxWorker({
    database,log:logger,uuid:()=> 'lease-1',
    deliver:async(_telegram,chatId,payload)=>sent.push({chatId,payload})
  });
  const result=await worker({}, {limit:10});
  assert.deepEqual(result,{claimed:1,delivered:1,failed:0,retried:0,uncertain:0});
  assert.equal(database.jobs[0].status,'sent');
  assert.deepEqual(sent,[{chatId:'12345',payload:{text:'hello'}}]);
});

test('ambiguous network failure becomes uncertain and stores/logs no raw exception text',async()=>{
  const database=fakeDatabase([job()]);
  const emitted=[];
  const log={warn:(data)=>emitted.push(data),error:(data)=>emitted.push(data)};
  const secret='temporary Telegram failure phone +989121234567 receipt SECRET-123';
  const worker=createNotificationOutboxWorker({
    database,log,uuid:()=> 'lease-2',
    deliver:async()=>{throw new Error(secret);}
  });
  const result=await worker({});
  assert.deepEqual(result,{claimed:1,delivered:0,failed:0,retried:0,uncertain:1});
  assert.equal(database.jobs[0].status,'uncertain');
  assert.equal(database.jobs[0].lease_token,null);
  assert.equal(database.jobs[0].last_error,'network_or_unknown');
  assert.equal(JSON.stringify(emitted).includes(secret),false);
  assert.equal(JSON.stringify(emitted).includes('989121234567'),false);
  assert.equal(JSON.stringify(emitted).includes('SECRET-123'),false);
});

test('notification reaches terminal failed state at the maximum attempt',async()=>{
  const database=fakeDatabase([job({attempts:7})]);
  const worker=createNotificationOutboxWorker({
    database,log:logger,uuid:()=> 'lease-3',
    deliver:async()=>{throw Object.assign(new Error('permanent Telegram rejection'),{response:{error_code:400}});}
  });
  await worker({});
  assert.equal(database.jobs[0].attempts,8);
  assert.equal(database.jobs[0].status,'failed');
  assert.equal(database.jobs[0].lease_token,null);
});


test('Telegram 429 response is safely retried using retry_after',async()=>{
  const database=fakeDatabase([job()]);
  const worker=createNotificationOutboxWorker({
    database,log:logger,uuid:()=> 'lease-429',
    deliver:async()=>{throw Object.assign(new Error('Too Many Requests'),{response:{error_code:429,parameters:{retry_after:12}}});}
  });
  const result=await worker({});
  assert.deepEqual(result,{claimed:1,delivered:0,failed:0,retried:1,uncertain:0});
  assert.equal(database.jobs[0].status,'pending');
  assert.equal(database.jobs[0].retry_delay,12);
  assert.equal(database.jobs[0].lease_token,null);
});

test('Telegram server error is uncertain rather than automatically retried',async()=>{
  const database=fakeDatabase([job()]);
  const worker=createNotificationOutboxWorker({
    database,log:logger,uuid:()=> 'lease-500',
    deliver:async()=>{throw Object.assign(new Error('Telegram server error'),{response:{error_code:500}});}
  });
  const result=await worker({});
  assert.deepEqual(result,{claimed:1,delivered:0,failed:0,retried:0,uncertain:1});
  assert.equal(database.jobs[0].status,'uncertain');
});

test('permanent Telegram 4xx response is terminal failed',async()=>{
  const database=fakeDatabase([job()]);
  const worker=createNotificationOutboxWorker({
    database,log:logger,uuid:()=> 'lease-400',
    deliver:async()=>{throw Object.assign(new Error('Bad Request'),{response:{error_code:400}});}
  });
  const result=await worker({});
  assert.deepEqual(result,{claimed:1,delivered:0,failed:1,retried:0,uncertain:0});
  assert.equal(database.jobs[0].status,'failed');
});

test('invalid notification payload is rejected without calling Telegram',async()=>{
  const database=fakeDatabase([job({payload:{}})]);
  let sends=0;
  const worker=createNotificationOutboxWorker({
    database,log:logger,uuid:()=> 'lease-4',
    deliver:async()=>{sends++;}
  });
  const result=await worker({});
  assert.equal(sends,0);
  assert.equal(result.failed,1);
  assert.equal(database.jobs[0].status,'failed');
  assert.equal(database.jobs[0].last_error,'invalid_payload');
});

test('expired sending lease becomes uncertain and is never automatically resent',async()=>{
  const database=fakeDatabase([job({status:'sending',stale:true,lease_token:'expired'})]);
  let sends=0;
  const worker=createNotificationOutboxWorker({
    database,log:logger,uuid:()=> 'lease-5',
    deliver:async()=>{sends++;}
  });
  const result=await worker({});
  assert.equal(sends,0);
  assert.deepEqual(result,{claimed:0,delivered:0,failed:0,retried:0,uncertain:0});
  assert.equal(database.jobs[0].status,'uncertain');
  assert.equal(database.jobs[0].lease_token,null);
});

test('lost lease after successful Telegram delivery is reported as uncertain',async()=>{
  const database=fakeDatabase([job()]);
  const worker=createNotificationOutboxWorker({
    database,log:logger,uuid:()=> 'lease-6',
    deliver:async()=>{
      database.jobs[0].status='uncertain';
      database.jobs[0].lease_token=null;
    }
  });
  const result=await worker({});
  assert.deepEqual(result,{claimed:1,delivered:0,failed:0,retried:0,uncertain:1});
  assert.equal(database.jobs[0].status,'uncertain');
});
