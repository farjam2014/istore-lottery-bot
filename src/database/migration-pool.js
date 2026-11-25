import mysql from 'mysql2/promise';
import {config} from '../config/env.js';
import {pool} from './pool.js';
import {resolveMigrationCredentials} from './migration-credentials.js';

let migrationPool;
export function getMigrationPool(){
  if(migrationPool)return migrationPool;
  const credentials=resolveMigrationCredentials(config);
  migrationPool=credentials.sharedRuntimePool?pool:mysql.createPool({
    host:config.MYSQL_HOST,
    port:config.MYSQL_PORT,
    database:config.MYSQL_DATABASE,
    user:credentials.user,
    password:credentials.password,
    waitForConnections:true,
    connectionLimit:1,
    queueLimit:0,
    charset:'utf8mb4',
    timezone:'Z',
    namedPlaceholders:true,
    enableKeepAlive:true
  });
  return migrationPool;
}
export async function closeMigrationPool(){
  if(migrationPool&&migrationPool!==pool){
    const current=migrationPool;
    migrationPool=undefined;
    await current.end();
  }
}
