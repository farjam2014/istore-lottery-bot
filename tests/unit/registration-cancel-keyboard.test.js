import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const keyboard=readFileSync(new URL('../../src/bot/keyboards/user.keyboard.js',import.meta.url),'utf8');
const handler=readFileSync(new URL('../../src/bot/handlers/registration.handler.js',import.meta.url),'utf8');

test('phone-sharing prompt offers contact sharing and cancellation in one reply keyboard',()=>{
  assert.match(keyboard,/button\\.contactRequest\\('📱 اشتراک‌گذاری شماره موبایل'\\)/);
  assert.match(keyboard,/❌ انصراف از ثبت‌نام/);
  assert.match(keyboard,/phoneShareKeyboard=\\(\\)=>Markup\\.keyboard/);
});

test('phone step sends a single prompt with the combined keyboard',()=>{
  assert.match(handler,/return ctx\\.reply\\('برای تأیید مالکیت شماره، از دکمه «اشتراک‌گذاری شماره موبایل» استفاده کنید\\. شماره‌ای که دستی تایپ شود پذیرفته نیست\\.',phoneShareKeyboard\\(\\)\\);/);
  assert.match(handler,/return ctx\\.reply\\('برای تأیید مالکیت، شماره موبایل خودتان را با دکمه زیر به اشتراک بگذارید\\. واردکردن دستی شماره پذیرفته نیست\\.',phoneShareKeyboard\\(\\)\\);/);
  assert.doesNotMatch(handler,/در صورت انصراف:/);
});

test('phone-step cancellation clears the session and presents a restart button',()=>{
  assert.match(handler,/s\\.step==='awaiting_phone'&&value==='❌ انصراف از ثبت‌نام'/);
  assert.match(handler,/clearSession\\(ctx\\.from\\.id\\)/);
  assert.match(handler,/registrationStartKeyboard\\(\\)/);
});
