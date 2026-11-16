import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const userPath=fileURLToPath(new URL('../../src/bot/handlers/user.handler.js',import.meta.url));
const adminPath=fileURLToPath(new URL('../../src/bot/handlers/admin.handler.js',import.meta.url));
const servicePath=fileURLToPath(new URL('../../src/modules/support/support-session.service.js',import.meta.url));
const [user,admin,service]=await Promise.all([readFile(userPath,'utf8'),readFile(adminPath,'utf8'),readFile(servicePath,'utf8')]);

const newTicketStart=user.indexOf("if(session.step==='new_message')");
const userReplyStart=user.indexOf("if(session.step==='user_reply')",newTicketStart);
const userReplyEnd=user.indexOf('return next();});',userReplyStart);
const newTicket=user.slice(newTicketStart,userReplyStart);
const userReply=user.slice(userReplyStart,userReplyEnd>userReplyStart?userReplyEnd:undefined);
const adminStart=admin.indexOf("const [supportRows]=await pool.execute");
const adminEnd=admin.indexOf("if(!wizard)return next();",adminStart);
const adminReply=admin.slice(adminStart,adminEnd);

test('new customer support ticket consumes the locked session before inserting a ticket',()=>{
  assert.ok(newTicketStart>=0);
  assert.ok(newTicket.indexOf('lockSupportSession')>=0);
  assert.ok(newTicket.indexOf('lockSupportSession')<newTicket.indexOf('INSERT INTO support_tickets'));
  assert.match(newTicket,/step:'new_message'/);
  assert.match(newTicket,/activeSession\.category/);
});

test('customer support reply consumes the locked session before inserting a message',()=>{
  assert.ok(userReplyStart>=0);
  assert.ok(userReply.indexOf('lockSupportSession')>=0);
  assert.ok(userReply.indexOf('lockSupportSession')<userReply.indexOf('INSERT INTO support_messages'));
  assert.match(userReply,/step:'user_reply'/);
  assert.match(userReply,/ticketId:session\.ticket_id/);
});

test('admin support reply consumes the locked session before inserting a message',()=>{
  assert.ok(adminStart>=0);
  assert.ok(adminReply.indexOf('lockSupportSession')>=0);
  assert.ok(adminReply.indexOf('lockSupportSession')<adminReply.indexOf('INSERT INTO support_messages'));
  assert.match(adminReply,/step:'admin_reply'/);
});

test('support session validation uses a current locking read and checks expected step and ticket',()=>{
  assert.match(service,/SELECT step,ticket_id,category FROM support_sessions WHERE telegram_user_id=\? FOR UPDATE/);
  assert.match(service,/session\.step!==step/);
  assert.match(service,/String\(session\.ticket_id\)!==String\(ticketId\)/);
});
