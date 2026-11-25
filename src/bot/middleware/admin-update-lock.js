import {pool} from '../../database/pool.js';
import {logger} from '../../shared/logger.js';
import {getAdminRole,isConfiguredSuperAdmin} from '../../modules/admin/admin-role.service.js';

const LOCK_TIMEOUT_SECONDS=15;

export function createAdminUpdateLock({
  database=pool,
  lookupAdmin=getAdminRole,
  isSuperAdmin=isConfiguredSuperAdmin,
  timeoutSeconds=LOCK_TIMEOUT_SECONDS
}={}){
  const timeout=Math.max(1,Math.min(60,Math.floor(Number(timeoutSeconds)||LOCK_TIMEOUT_SECONDS)));
  return async(ctx,next)=>{
    const telegramId=ctx.from?.id;
    if(telegramId===undefined||telegramId===null)return next();
    const admin=isSuperAdmin(telegramId)?{is_active:1}:await lookupAdmin(telegramId);
    if(!admin||Number(admin.is_active)!==1)return next();

    const connection=await database.getConnection();
    const lockName='ustore-admin-update:'+String(telegramId);
    let acquired=false;
    try{
      const [[lock]]=await connection.execute('SELECT GET_LOCK(?, ?) AS acquired',[lockName,timeout]);
      if(Number(lock?.acquired)!==1)throw new Error('Timed out waiting for the previous update from this admin account.');
      acquired=true;
      return await next();
    }finally{
      try{
        if(acquired)await connection.execute('SELECT RELEASE_LOCK(?) AS released',[lockName]);
      }catch(error){
        logger.warn({err:error,telegramId},'Failed to release admin update lock');
      }finally{
        connection.release();
      }
    }
  };
}

export function adminUpdateLock(){
  return createAdminUpdateLock();
}
