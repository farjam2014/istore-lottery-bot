import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const keyboard=readFileSync(new URL('../../src/bot/keyboards/user.keyboard.js',import.meta.url),'utf8');
const handler=readFileSync(new URL('../../src/bot/handlers/registration.handler.js',import.meta.url),'utf8');

test('phone-sharing prompt offers contact sharing and cancellation in one reply keyboard',()=>{
  assert.ok(keyboard.includes("Markup.button.contactRequest('📱 اشتراک‌گذاری شماره موبایل')"));
  assert.ok(keyboard.includes("['❌ انصراف از ثبت‌نام']"));
  assert.ok(keyboard.includes('export const phoneShareKeyboard=()=>Markup.keyboard(['));
});

test('phone step sends a single prompt with the combined keyboard',()=>{
  assert.ok(handler.includes("return ctx.reply('برای تأیید مالکیت شماره، از دکمه «اشتراک‌گذاری شماره موبایل» استفاده کنید. شماره‌ای که دستی تایپ شود پذیرفته نیست.',phoneShareKeyboard());"));
  assert.ok(handler.includes("return ctx.reply('برای تأیید مالکیت، شماره موبایل خودتان را با دکمه زیر به اشتراک بگذارید. واردکردن دستی شماره پذیرفته نیست.',phoneShareKeyboard());"));
  assert.ok(!handler.includes('در صورت انصراف:'));
});

test('phone-step cancellation clears the session and presents a restart button',()=>{
  assert.ok(handler.includes("if(s.step==='awaiting_phone'&&value==='❌ انصراف از ثبت‌نام')"));
  assert.ok(handler.includes('clearSession(ctx.from.id)'));
  assert.ok(handler.includes('registrationStartKeyboard()'));
});
