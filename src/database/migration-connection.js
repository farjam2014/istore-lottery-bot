export async function releaseMigrationConnection(connection,{lockName,lockAcquisitionResolved,lockAcquired}){
  let reusable=lockAcquisitionResolved===true;
  if(lockAcquired===true){
    try{
      const [[released]]=await connection.query('SELECT RELEASE_LOCK(?) AS released',[lockName]);
      reusable=Number(released?.released)===1;
    }catch{
      reusable=false;
    }
  }
  if(reusable)connection.release();
  else connection.destroy();
}
