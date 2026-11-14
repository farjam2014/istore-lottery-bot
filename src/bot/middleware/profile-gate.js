import {config} from '../../config/env.js';
import {hasPermission} from '../../modules/admin/admin-role.service.js';
import {findProfile,getSession} from '../../modules/participants/participant.service.js';
import {registrationKeyboard} from '../keyboards/user.keyboard.js';
import {isRegistrationUpdateAllowed} from './registration-gate.js';
export function profileGate(){return async(ctx,next)=>{
  if(!ctx.from)return;
  if(config.adminIds.has(String(ctx.from.id))||await hasPermission(ctx.from.id,'dashboard.read'))return next();
  const p=await findProfile(ctx.from.id);
  if(p?.status==='blocked'){if(ctx.callbackQuery)await ctx.answerCbQuery('حساب شما مسدود است. برای پیگیری با پشتیبانی تماس بگیرید.',{show_alert:true}).catch(()=>{});else await ctx.reply('حساب شما مسدود است. برای پیگیری با پشتیبانی تماس بگیرید.');return;}
  if(p){ctx.state.profile=p;return next();}
  const session=await getSession(ctx.from.id);
  const allowed=isRegistrationUpdateAllowed({
    callbackData:ctx.callbackQuery?.data,
    command:(ctx.message?.text||'').split(/\s/)[0],
    session,
    message:ctx.message
  });
  if(allowed)return next();
  if(ctx.callbackQuery){await ctx.answerCbQuery('ابتدا ثبت‌نام کنید.',{show_alert:true}).catch(()=>{});return;}
  await ctx.reply('برای استفاده از امکانات ربات، ابتدا ثبت‌نام کنید.',registrationKeyboard());
};}
