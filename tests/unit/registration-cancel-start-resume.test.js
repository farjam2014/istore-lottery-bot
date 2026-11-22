import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const startHandler=readFileSync(new URL('../../src/bot/handlers/start.handler.js',import.meta.url),'utf8');

test('/start resumes an awaiting-phone registration with the contact-share keyboard',()=>{
  assert.ok(startHandler.includes("if(s.step==='awaiting_phone')"));
  assert.ok(startHandler.includes("return ctx.reply('برای ادامه ثبت‌نام، شماره موبایل خودتان را به اشتراک بگذارید. برای لغو، دکمه «انصراف از ثبت‌نام» را بزنید.',phoneShareKeyboard());"));
});
