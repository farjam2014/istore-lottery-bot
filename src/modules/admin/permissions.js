export const rolePermissions=Object.freeze({
  super_admin:Object.freeze(['*']),
  campaign_manager:Object.freeze(['dashboard.read','campaign.read','campaign.write','participant.read']),
  finance_manager:Object.freeze(['dashboard.read','payment.read','payment.review','payment.settings','report.read']),
  support_agent:Object.freeze(['dashboard.read','support.read','support.reply','support.manage'])
});
export const assignableRoles=Object.freeze(['campaign_manager','finance_manager','support_agent']);
export function roleHasPermission(role,permission){
  const allowed=rolePermissions[role]||[];
  return allowed.includes('*')||allowed.includes(permission);
}
