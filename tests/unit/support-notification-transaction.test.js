import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const handlerPath=fileURLToPath(new URL('../../src/bot/handlers/user.handler.js',import.meta.url));
const source=await readFile(handlerPath,'utf8');
const newTicketStart=source.indexOf("if(session.step==='new_message')");
const userReplyStart=source.indexOf("if(session.step==='user_reply')",newTicketStart);
const afterReply=source.indexOf('return next();});',userReplyStart);
const newTicket=source.slice(newTicketStart,userReplyStart);
const userReply=source.slice(userReplyStart,afterReply>userReplyStart?afterReply:undefined);

test('new support ticket enqueues admin notifications before committing the ticket transaction',()=>{
  assert.ok(newTicketStart>=0);
  assert.match(newTicket,/await enqueueSupportAdminNotification\([\s\S]*?executor:c/);
  assert.ok(newTicket.indexOf('await enqueueSupportAdminNotification')<newTicket.indexOf('await c.commit()'));
  assert.match(newTicket,/await c.rollback\(\)/);
});

test('customer support reply enqueues admin notifications before committing the reply transaction',()=>{
  assert.ok(userReplyStart>=0);
  assert.match(userReply,/await enqueueSupportAdminNotification\([\s\S]*?executor:c/);
  assert.ok(userReply.indexOf('await enqueueSupportAdminNotification')<userReply.indexOf('await c.commit()'));
  assert.match(userReply,/await c.rollback\(\)/);
});
