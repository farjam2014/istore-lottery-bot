import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const userPath=fileURLToPath(new URL('../../src/bot/handlers/user.handler.js',import.meta.url));
const paymentPath=fileURLToPath(new URL('../../src/bot/handlers/payment.handler.js',import.meta.url));
const user=readFileSync(userPath,'utf8');
const payment=readFileSync(paymentPath,'utf8');

test('campaign poster and description are sent as one photo message with inline keyboard',()=>{
  assert.ok(user.includes("const sent=await ctx.replyWithPhoto(campaign.poster_file_id,{caption,reply_markup:Markup.inlineKeyboard(buttons).reply_markup}"));
  assert.ok(user.includes("if(truncated)await ctx.reply('📋 متن کامل توضیحات و قوانین کمپین:\\n\\n'+description)"));
  assert.ok(!user.includes("await ctx.replyWithPhoto(campaign.poster_file_id,{caption:'پوستر کمپین: '+campaign.title})"));
});

test('paid quantity selection edits the campaign message instead of sending a new prompt',()=>{
  assert.ok(payment.includes("return ctx.editMessageCaption(base+safePrompt,{reply_markup:keyboard.reply_markup})"));
  assert.ok(payment.includes("return ctx.editMessageText(base+safePrompt,{reply_markup:keyboard.reply_markup})"));
  assert.ok(!payment.includes("return ctx.reply('چند کد می‌خواهید؟'"));
});

test('quantity selection starts at one and retains campaign back navigation',()=>{
  assert.ok(payment.includes("return showPaymentQuantityPrompt(ctx,campaignId,0,1)"));
  assert.ok(payment.includes("'campaign:view:'+campaignId"));
});
