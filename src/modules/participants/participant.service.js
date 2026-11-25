import * as repo from './participant.repository.js';

export const findProfile=repo.findByTelegramId;
export const updatePrivacyConsent=repo.updatePrivacyConsent;
export const getSession=repo.getSession;
export const saveSession=repo.saveSession;
export const advanceSession=repo.advanceSession;
export const clearSession=repo.clearSession;
export const clearSessionIfNewer=repo.clearSessionIfNewer;

export function normalizePhone(value){
  let phone=String(value??'').trim().replace(/[\s()-]/g,'');
  if(/^09\d{9}$/.test(phone)) phone='+98'+phone.slice(1);
  if(/^989\d{9}$/.test(phone)) phone='+'+phone;
  if(!/^\+[1-9]\d{9,14}$/.test(phone)) throw new Error('شماره موبایل معتبر نیست. نمونه: 09121234567');
  return phone;
}
export function normalizeInstagram(value){
  const handle=String(value??'').trim().replace(/^@/,'');
  if(!/^[A-Za-z0-9._]{2,30}$/.test(handle)) throw new Error('آیدی اینستاگرام معتبر نیست. فقط حروف انگلیسی، عدد، نقطه و زیرخط مجاز است.');
  return handle;
}
export function normalizeFullName(value){
  const name=String(value??'').trim().replace(/\s+/g,' ');
  if(name.length<3||name.length>160||/[\d<>]/.test(name)) throw new Error('نام و نام خانوادگی باید معتبر و بین ۳ تا ۱۶۰ نویسه باشد.');
  return name;
}
export async function completeRegistration(ctx,data,expectedLastUpdateId){
  return repo.completeProfileFromSession({
    telegramUserId:ctx.from.id,
    username:ctx.from.username,
    fullName:normalizeFullName(data.fullName),
    phone:normalizePhone(data.phone),
    instagramHandle:normalizeInstagram(data.instagramHandle),
    expectedLastUpdateId,
    updateId:ctx.update.update_id
  });
}
