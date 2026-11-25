import {pool} from '../../database/pool.js';

async function updateAdminAccess({targetId,actorId,role,isActive,expectedActive,database=pool}){
  const c=await database.getConnection();
  try{
    await c.beginTransaction();
    const [[target]]=await c.execute('SELECT role,is_active FROM admin_users WHERE telegram_user_id=? FOR UPDATE',[String(targetId)]);
    if(!target)throw new Error('مدیر پیدا نشد.');
    const nextRole=role??target.role;
    const currentActive=Number(target.is_active);
    if(expectedActive!==undefined&&currentActive!==Number(expectedActive))throw new Error('وضعیت مدیر از زمان نمایش این دکمه تغییر کرده است؛ فهرست مدیران را تازه‌سازی کنید.');
    const nextActive=isActive===undefined?currentActive:Number(isActive);
    if(![0,1].includes(nextActive))throw new Error('وضعیت جدید مدیر معتبر نیست.');
    if(target.role==='super_admin'&&currentActive===1&&(nextRole!=='super_admin'||nextActive!==1)){
      const [activeSuperAdmins]=await c.execute("SELECT telegram_user_id FROM admin_users WHERE role='super_admin' AND is_active=1 FOR UPDATE");
      if(activeSuperAdmins.length<=1)throw new Error('غیرفعال‌سازی یا تغییر نقش آخرین مدیر کل فعال مجاز نیست.');
    }
    if(role!==undefined&&role!==target.role)await c.execute('UPDATE admin_users SET role=? WHERE telegram_user_id=?',[role,String(targetId)]);
    if(isActive!==undefined&&nextActive!==currentActive)await c.execute('UPDATE admin_users SET is_active=? WHERE telegram_user_id=?',[nextActive,String(targetId)]);
    const action=role!==undefined&&role!==target.role?'role_changed':nextActive!==currentActive?(nextActive?'activated':'deactivated'):null;
    if(action)await c.execute('INSERT INTO admin_role_events(target_telegram_id,actor_telegram_id,action,role_before,role_after) VALUES(?,?,?,?,?)',[String(targetId),String(actorId),action,target.role,nextRole]);
    await c.commit();
    return {role:nextRole,is_active:nextActive,changed:Boolean(action)};
  }catch(error){await c.rollback();throw error;}finally{c.release();}
}
export async function changeAdminRole({targetId,actorId,role,database=pool}){
  if(!['campaign_manager','finance_manager','support_agent'].includes(role))throw new Error('نقش انتخاب‌شده معتبر نیست.');
  return updateAdminAccess({targetId,actorId,role,database});
}
export async function setAdminActive({targetId,actorId,isActive,expectedActive,database=pool}){
  if(![0,1].includes(Number(isActive))||![0,1].includes(Number(expectedActive)))throw new Error('وضعیت درخواستی معتبر نیست.');
  return updateAdminAccess({targetId,actorId,isActive:Number(isActive),expectedActive:Number(expectedActive),database});
}


export async function assignAdminRoleFromSession({actorId,targetId,database=pool}){
  const c=await database.getConnection();
  try{
    await c.beginTransaction();
    const [[session]]=await c.execute('SELECT role FROM admin_role_sessions WHERE telegram_user_id=? FOR UPDATE',[String(actorId)]);
    if(!session)throw new Error('نشست افزودن مدیر منقضی شده است؛ دوباره فرایند را آغاز کنید.');
    const role=session.role;
    if(!['campaign_manager','finance_manager','support_agent'].includes(role))throw new Error('نقش ذخیره‌شده برای افزودن مدیر معتبر نیست.');
    const [[target]]=await c.execute('SELECT role,is_active FROM admin_users WHERE telegram_user_id=? FOR UPDATE',[String(targetId)]);
    if(target?.role==='super_admin'&&Number(target.is_active)===1&&role!=='super_admin'){
      const [activeSuperAdmins]=await c.execute("SELECT telegram_user_id FROM admin_users WHERE role='super_admin' AND is_active=1 FOR UPDATE");
      if(activeSuperAdmins.length<=1)throw new Error('تغییر نقش آخرین مدیر کل فعال مجاز نیست.');
    }
    if(target){
      if(target.role!==role)await c.execute('UPDATE admin_users SET role=? WHERE telegram_user_id=?',[role,String(targetId)]);
    }else{
      await c.execute('INSERT INTO admin_users(telegram_user_id,role,is_active,added_by) VALUES(?,?,1,?)',[String(targetId),role,String(actorId)]);
    }
    const action=target?(target.role===role?null:'role_changed'):'assigned';
    if(action)await c.execute('INSERT INTO admin_role_events(target_telegram_id,actor_telegram_id,action,role_before,role_after) VALUES(?,?,?,?,?)',[String(targetId),String(actorId),action,target.role||null,role]);
    const [deleted]=await c.execute('DELETE FROM admin_role_sessions WHERE telegram_user_id=? AND role=?',[String(actorId),role]);
    if(!deleted.affectedRows)throw new Error('نشست افزودن مدیر قبلاً مصرف شده است؛ دوباره فرایند را آغاز کنید.');
    await c.commit();
    return {role,changed:Boolean(action),created:!target,isActive:target?Number(target.is_active):1};
  }catch(error){await c.rollback();throw error;}finally{c.release();}
}
