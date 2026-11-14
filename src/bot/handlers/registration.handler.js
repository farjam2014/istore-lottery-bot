import {completeRegistration,getSession,saveSession,clearSession,normalizeFullName,normalizePhone} from '../../modules/participants/participant.service.js';
import {promptFor} from './start.handler.js';
import {userMenuKeyboard,cancelKeyboard,registrationKeyboard} from '../keyboards/user.keyboard.js';
import {config} from '../../config/env.js';
export function registerRegistrationHandlers(bot){
  bot.action('registration:start',async ctx=>{await ctx.answerCbQuery();const s=await getSession(ctx.from.id);if(!s)await saveSession(ctx.from.id,'awaiting_name',{});await ctx.reply(promptFor(s?.step||'awaiting_name'),cancelKeyboard());});
  bot.action('registration:cancel',async ctx=>{await clearSession(ctx.from.id);await ctx.answerCbQuery('ثبت‌نام متوقف شد.');await ctx.reply('هر زمان خواستید می‌توانید ثبت‌نام را شروع کنید.',registrationKeyboard());});
  bot.command('cancel',async ctx=>{await clearSession(ctx.from.id);await ctx.reply('فرآیند ثبت‌نام لغو شد.',registrationKeyboard());});
  bot.on('text',async(ctx,next)=>{
    if(config.adminIds.has(String(ctx.from.id)))return next();
    const s=await getSession(ctx.from.id);if(!s)return next();
    const value=ctx.message.text.trim();const data=s.payload||{};
    try{
      if(s.step==='awaiting_name'){normalizeFullName(value);data.fullName=value;await saveSession(ctx.from.id,'awaiting_phone',data);return ctx.reply(promptFor('awaiting_phone'),cancelKeyboard());}
      if(s.step==='awaiting_phone'){normalizePhone(value);data.phone=value;await saveSession(ctx.from.id,'awaiting_instagram',data);return ctx.reply(promptFor('awaiting_instagram'),cancelKeyboard());}
      if(s.step==='awaiting_instagram'){data.instagramHandle=value;await completeRegistration(ctx,data);return ctx.reply('ثبت‌نام شما با موفقیت تکمیل شد. اطلاعات حساب شما ذخیره شد.',userMenuKeyboard());}
    }catch(error){return ctx.reply(error.message||'خطا در ثبت اطلاعات. دوباره تلاش کنید.');}
    return next();
  });
}
