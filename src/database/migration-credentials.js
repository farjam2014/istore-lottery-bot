export function resolveMigrationCredentials(config){
  const user=config.MYSQL_MIGRATION_USER;
  const password=config.MYSQL_MIGRATION_PASSWORD;
  if(config.NODE_ENV==='production'){
    if(!user||!password)throw new Error('Production migrations require separate MYSQL_MIGRATION_USER and MYSQL_MIGRATION_PASSWORD credentials from a protected migration-only environment file.');
    if(user===config.MYSQL_USER)throw new Error('The migration database account must be different from the runtime MYSQL_USER.');
    if(password===config.MYSQL_PASSWORD)throw new Error('The migration database password must be different from the runtime MYSQL_PASSWORD.');
    return {user,password,sharedRuntimePool:false};
  }
  if(Boolean(user)!==Boolean(password))throw new Error('MYSQL_MIGRATION_USER and MYSQL_MIGRATION_PASSWORD must be supplied together.');
  if(user&&user===config.MYSQL_USER)throw new Error('The migration database account must be different from MYSQL_USER when explicitly configured.');
  return user?{user,password,sharedRuntimePool:false}:{user:config.MYSQL_USER,password:config.MYSQL_PASSWORD,sharedRuntimePool:true};
}
