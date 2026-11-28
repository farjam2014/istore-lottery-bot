export async function releaseMigrationConnection(connection,{lockAcquisitionResolved=false,lockAcquired=false,lockName}={}){
  let reusable=Boolean(lockAcquisitionResolved);
  if(lockAcquired){
    try{
      const [[result]]=await connection.query('SELECT RELEASE_LOCK(?) AS released',[lockName]);
      reusable=Number(result?.released)===1;
    }catch{
      reusable=false;
    }
  }
  if(reusable)connection.release();
  else connection.destroy();
  return reusable;
}
