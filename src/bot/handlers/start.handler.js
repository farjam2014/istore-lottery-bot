import {findProfile,getSession} from '../../modules/participants/participant.service.js';
import {getAdminRole} from '../../modules/admin/admin-role.service.js';
import {registrationKeyboard,userMenuKeyboard,cancelKeyboard,phoneShareKeyboard} from '../keyboards/user.keyboard.js';
export const promptFor=step=>({
 awaiting_name:'نام و نام خانوادگی خود را وارد کنید.',
 awaiting_phone:'برای تأیید مالکیت، شماره موبایل خود را با دکمه اشتراک‌گذاری ارسال کنید؛ تایپ دستی پذیرفته نیست.',
 awaiting_instagram:'آیدی اینستاگرام را بدون @ وارد کنید.'
}[step]||'ثبت‌نام را آغاز کنید.');
export function registerStartHandlers(bot){
 bot.start(async ctx=>{
  const admin=await getAdminRole(ctx.from.id);
  if(admin&&Number(admin.is_active)===1)return ctx.reply('حساب مدیریتی شما فعال است. برای ورود به پنل مدیریت دستور /admin را ارسال کنید.');
  const p=await findProfile(ctx.from.id);
  if(p)return ctx.reply('خوش برگشتید. از منوی زیر استفاده کنید:',userMenuKeyboard());
  const s=await getSession(ctx.from.id);
  if(s){
   if(s.step==='awaiting_phone'){
    await ctx.reply('برای ادامه ثبت‌نام، شماره موبایل خودتان را به اشتراک بگذارید.',phoneShareKeyboard());
    return ctx.reply('در صورت انصراف:',cancelKeyboard());
   }
   return ctx.reply(promptFor(s.step),cancelKeyboard());
  }
  return ctx.reply('به ربات رسمی iStore خوش آمدید. برای ایجاد حساب کاربری، ثبت‌نام را آغاز کنید.',registrationKeyboard());
 });
}
