import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const userPath=fileURLToPath(new URL('../../src/bot/handlers/user.handler.js',import.meta.url));
const paymentPath=fileURLToPath(new URL('../../src/bot/handlers/payment.handler.js',import.meta.url));
const user=readFileSync(userPath,'utf8');
const payment=readFileSync(paymentPath,'utf8');

test('campaign poster and description are sent as one photo message with inline keyboard',()=>{
  assert.ok(user.includes("return ctx.replyWithPhoto(campaign.poster_file_id,{caption,reply_markup:Markup.inlineKeyboard(buttons).reply_markup}"));
  assert.ok(!user.includes("await ctx.replyWithPhoto(campaign.poster_file_id,{caption:'پوستر کمپین: '+campaign.title})"));
});

test('paid quantity selection edits the campaign message instead of sending a new prompt',()=>{
  assert.ok(payment.includes("return ctx.editMessageCaption(base+prompt,{reply_markup:keyboard.reply_markup})"));
  assert.ok(payment.includes("return ctx.editMessageText(base+prompt,{reply_markup:keyboard.reply_markup})"));
  assert.ok(!payment.includes("return ctx.reply('چند کد می‌خواهید؟'"));
});

test('quantity selection starts at one and retains campaign back navigation',()=>{
  assert.ok(payment.includes("return showPaymentQuantityPrompt(ctx,campaignId,0,1)"));
  assert.ok(payment.includes("'campaign:view:'+campaignId"));
});

test('quantity prompt uses real newline escapes and respects Telegram caption/text limits',()=>{
  assert.ok(payment.includes("const marker='\\n\\n🧮 انتخاب تعداد کد'"));
  assert.ok(payment.includes("const prompt=marker+'\\nقیمت هر کد:"));
  assert.ok(payment.includes('const captionLimit=1024-prompt.length'));
  assert.ok(payment.includes('const textLimit=4096-prompt.length'));
});

test('payment start answers callback only once, including alert branches',()=>{
  const start=payment.split("bot.action(/^payment:start:(\\\\d+)$/")[1]?.split("bot.action(/^payment:more:/")[0]||'';
  assert.ok(start.includes("return ctx.answerCbQuery('کمپین برای سفارش پولی در دسترس نیست.'"));
  assert.ok(start.includes("return ctx.answerCbQuery('سقف کدهای مجاز شما تکمیل شده یا سفارش فعالی دارید.'"));
  assert.ok(start.includes('await ctx.answerCbQuery();'));
  assert.equal((start.match(/answerCbQuery/g)||[]).length,3);
});

test('campaign poster caption truncation includes continuation text within 1024 characters',()=>{
  assert.ok(user.includes("const suffix='\\n\\n… ادامه توضیحات در بخش شرایط کمپین'"));
  assert.ok(user.includes('description.slice(0,1024-suffix.length)+suffix'));
});
