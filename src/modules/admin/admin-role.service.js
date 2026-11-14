import {config} from '../../config/env.js';
import {pool} from '../../database/pool.js';
import {roleHasPermission,rolePermissions,assignableRoles} from './permissions.js';

export function isConfiguredSuperAdmin(telegramId){return config.adminIds.has(String(telegramId));}
export async function getAdminRole(telegramId){
  if(isConfiguredSuperAdmin(telegramId))return {role:'super_admin',is_active:1,source:'environment'};
  const [[row]]=await pool.execute('SELECT role,is_active,display_name FROM admin_users WHERE telegram_user_id=?',[String(telegramId)]);
  return row||null;
}
export async function hasPermission(telegramId,permission){
  const admin=await getAdminRole(telegramId);
  if(!admin||Number(admin.is_active)!==1)return false;
  return roleHasPermission(admin.role,permission);
}
export function permissionsForRole(role){return rolePermissions[role]?[...rolePermissions[role]]:[];}
export {assignableRoles};
