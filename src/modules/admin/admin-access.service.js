import {pool} from '../../database/pool.js';

async function updateAdminAccess({targetId,actorId,role,isActive}){
  const c=await pool.getConnection();
  try{
    await c.beginTransaction();
    const [[target]]=await c.execute('SELECT role,is_active FROM admin_users WHERE telegram_user_id=? FOR UPDATE',[String(targetId)]);
    if(!target)throw new Error('مدیر پیدا نشد.');
    const nextRole=role??target.role;
    const nextActive=isActive===undefined?Number(target.is_active):Number(isActive);
    if(target.role==='super_admin'&&Number(target.is_active)===1&&(nextRole!=='super_admin'||nextActive!==1)){
      const [activeSuperAdmins]=await c.execute("SELECT telegram_user_id FROM admin_users WHERE role='super_admin' AND is_active=1 FOR UPDATE");
      if(activeSuperAdmins.length<=1)throw new Error('غیرفعال‌سازی یا تغییر نقش آخرین مدیر کل فعال مجاز نیست.');
    }
    if(role!==undefined)await c.execute('UPDATE admin_users SET role=? WHERE telegram_user_id=?',[role,String(targetId)]);
    if(isActive!==undefined)await c.execute('UPDATE admin_users SET is_active=? WHERE telegram_user_id=?',[nextActive,String(targetId)]);
    const action=role!==undefined&&role!==target.role?'role_changed':nextActive!==Number(target.is_active)?(nextActive?'activated':'deactivated'):null;
    if(action)await c.execute('INSERT INTO admin_role_events(target_telegram_id,actor_telegram_id,action,role_before,role_after) VALUES(?,?,?,?,?)',[String(targetId),String(actorId),action,target.role,nextRole]);
    await c.commit();
    return {role:nextRole,is_active:nextActive,changed:Boolean(action)};
  }catch(error){await c.rollback();throw error;}finally{c.release();}
}
export async function changeAdminRole({targetId,actorId,role}){
  if(!['campaign_manager','finance_manager','support_agent'].includes(role))throw new Error('نقش انتخاب‌شده معتبر نیست.');
  return updateAdminAccess({targetId,actorId,role});
}
export async function toggleAdminActive({targetId,actorId}){
  const [[target]]=await pool.execute('SELECT is_active FROM admin_users WHERE telegram_user_id=?',[String(targetId)]);
  if(!target)throw new Error('مدیر پیدا نشد.');
  return updateAdminAccess({targetId,actorId,isActive:Number(target.is_active)?0:1});
}
