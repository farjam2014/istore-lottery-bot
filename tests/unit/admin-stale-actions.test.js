import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../../src/bot/handlers/admin.handler.js',import.meta.url),'utf8');

test('participant block and unblock callbacks bind the observed state and reject stale actions',()=>{
  assert.ok(source.includes('`admin:participant:${action}:${id}:${Number(ctx.match[2])||0}:${p.status}`'));
  assert.ok(source.includes('bot.action(/^admin:participant:(block|unblock):(\\d+):(\\d+):(active|blocked)$/'));
  assert.ok(source.includes('expectedStatus=ctx.match[4]'));
  assert.ok(source.includes('if(p.status!==expectedStatus)'));
  assert.ok(source.includes('وضعیت شرکت‌کننده از زمان نمایش این دکمه تغییر کرده است'));
});

test('support status callbacks bind the observed state and reject stale actions',()=>{
  assert.ok(source.includes("'admin:support:status:'+id+':'+(t.status==='closed'?'new':'closed')+':'+t.status"));
  assert.ok(source.includes('bot.action(/^admin:support:status:(\\d+):(new|in_progress|answered|closed):(new|in_progress|answered|closed)$/'));
  assert.ok(source.includes('expectedStatus=ctx.match[3]'));
  assert.ok(source.includes('if(ticket.status!==expectedStatus)'));
  assert.ok(source.includes('وضعیت تیکت از زمان نمایش این دکمه تغییر کرده است'));
  assert.ok(source.includes("if(ticket.status!==status){await c.execute('UPDATE support_tickets"));
});
