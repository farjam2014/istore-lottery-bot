import {randomUUID} from 'node:crypto';
import {pool} from '../../database/pool.js';

const LEASE_SECONDS=300;

export async function claimProcessedUpdate({updateId,correlationId,executor=pool}){
  const leaseToken=randomUUID();
  const [insert]=await executor.execute(
    "INSERT IGNORE INTO processed_updates(update_id,correlation_id,status,lease_token,lease_expires_at,attempts) VALUES(?,?,'processing',?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? SECOND),1)",
    [updateId,correlationId,leaseToken,LEASE_SECONDS]
  );
  if(Number(insert.affectedRows)===1){
    return {claimed:true,isNew:true,leaseToken,correlationId};
  }
  const [[existing]]=await executor.execute(
    'SELECT status,correlation_id FROM processed_updates WHERE update_id=?',
    [updateId]
  );
  if(!existing||existing.status==='completed')return {claimed:false,reason:'completed'};
  const [reclaimed]=await executor.execute(
    "UPDATE processed_updates SET correlation_id=COALESCE(correlation_id,?),lease_token=?,lease_expires_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? SECOND),attempts=attempts+1 WHERE update_id=? AND status='processing' AND (lease_expires_at IS NULL OR lease_expires_at<=UTC_TIMESTAMP())",
    [correlationId,leaseToken,LEASE_SECONDS,updateId]
  );
  if(Number(reclaimed.affectedRows)===1){
    return {claimed:true,isNew:false,leaseToken,correlationId:existing.correlation_id||correlationId};
  }
  return {claimed:false,reason:'processing'};
}

export async function completeProcessedUpdate({updateId,leaseToken,executor=pool}){
  const [result]=await executor.execute(
    "UPDATE processed_updates SET status='completed',processed_at=UTC_TIMESTAMP(),lease_token=NULL,lease_expires_at=NULL WHERE update_id=? AND status='processing' AND lease_token=?",
    [updateId,leaseToken]
  );
  return Number(result.affectedRows)===1;
}

export async function releaseProcessedUpdate({updateId,leaseToken,executor=pool}){
  const [result]=await executor.execute(
    "DELETE FROM processed_updates WHERE update_id=? AND status='processing' AND lease_token=?",
    [updateId,leaseToken]
  );
  return Number(result.affectedRows)===1;
}
