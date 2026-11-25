import {Markup} from 'telegraf';
export const registrationKeyboard=()=>Markup.inlineKeyboard([[Markup.button.callback('ثبت‌نام','registration:start')]]);
export const privacyNoticeKeyboard=(url,expectedCursor=null)=>{const cursor=expectedCursor===null||expectedCursor===undefined?-1:(Number.isSafeInteger(Number(expectedCursor))?Number(expectedCursor):-1);return Markup.inlineKeyboard([...(url?[[Markup.button.url('مطالعه اطلاعیه حریم خصوصی',url)]]:[]),[Markup.button.callback('خواندم و می‌پذیرم','privacy:accept:'+cursor)],[Markup.button.callback('انصراف از ثبت‌نام','registration:cancel:'+cursor)]]);};
export const registrationStartKeyboard=()=>Markup.keyboard([['ثبت‌نام']]).resize().oneTime();
export const userMenuKeyboard=()=>Markup.inlineKeyboard([
 [Markup.button.callback('🎁 کمپین‌ها','user:campaigns'),Markup.button.callback('🎟 کدهای من','user:codes')],
 [Markup.button.callback('📚 سوابق شرکت من','user:history'),Markup.button.callback('🧾 سفارش‌ها','user:orders')],
 [Markup.button.callback('👤 حساب کاربری','user:account'),Markup.button.callback('💬 پشتیبانی','user:support')]
]);
export const cancelKeyboard=lastUpdateId=>Markup.inlineKeyboard([[Markup.button.callback('انصراف از ثبت‌نام','registration:cancel:'+String(lastUpdateId===null||lastUpdateId===undefined?-1:(Number.isSafeInteger(Number(lastUpdateId))?Number(lastUpdateId):-1)))]]);
export const phoneShareKeyboard=()=>Markup.keyboard([
 [Markup.button.contactRequest('📱 اشتراک‌گذاری شماره موبایل')],
 ['❌ انصراف از ثبت‌نام']
]).resize().oneTime();
