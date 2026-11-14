import {config} from '../../config/env.js';
import {pool} from '../../database/pool.js';

const permissions={
  super_admin:['*'],
  campaign_manager:['dashboard.read','campaign.read','campaign.write','participant.read'],
  finance_manager:['dashboard.read','payment.read','payment.review','payment.settings','report.read','participant.read'],
  support_agent:['dashboard.read','support.read','support.reply','support.manage','participant.read']
};
export function isConfiguredSuperAdmin(telegramId){return config.adminIds.has(String(telegramId));}
export async function getAdminRole(telegramId){
  if(isConfiguredSuperAdmin(telegramId))return {role:'super_admin',is_active:1,source:'environment'};
  const [[row]]=await pool.execute('SELECT role,is_active,display_name FROM admin_users WHERE telegram_user_id=?',[String(telegramId)]);
  return row||null;
}
export async function hasPermission(telegramId,permission){
  const admin=await getAdminRole(telegramId);
  if(!admin||Number(admin.is_active)!==1)return false;
  return (permissions[admin.role]||[]).includes('*')||(permissions[admin.role]||[]).includes(permission);
}
export function permissionsForRole(role){return permissions[role]?[...permissions[role]]:[];}
export const assignableRoles=['campaign_manager','finance_manager','support_agent'];
