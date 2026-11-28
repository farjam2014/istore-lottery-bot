import mysql from 'mysql2/promise';
import {config} from '../config/env.js';

const connectionOptions={host:config.MYSQL_HOST,port:config.MYSQL_PORT,database:config.MYSQL_DATABASE,user:config.MYSQL_USER,password:config.MYSQL_PASSWORD,waitForConnections:true,queueLimit:0,charset:'utf8mb4',timezone:'Z',namedPlaceholders:true,enableKeepAlive:true};

export const pool=mysql.createPool({...connectionOptions,connectionLimit:config.MYSQL_POOL_SIZE});
// MySQL advisory locks are connection-scoped. Keep them on a separate pool so
// an admin handler waiting for a normal application connection cannot deadlock
// the pool while it holds GET_LOCK() on the same pool.
export const adminLockPool=mysql.createPool({...connectionOptions,connectionLimit:5});

export async function pingDatabase(){const [r]=await pool.query('SELECT 1 AS ok');return r[0]?.ok===1;}
