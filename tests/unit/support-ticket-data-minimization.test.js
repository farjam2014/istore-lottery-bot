import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const source=readFileSync(fileURLToPath(new URL('../../src/bot/handlers/admin.handler.js',import.meta.url)),'utf8');
const start=source.indexOf("bot.action(/^admin:support:view:");
const end=source.indexOf("\n",start);
const handler=source.slice(start,end);

test('support ticket detail does not query or disclose participant contact identifiers',()=>{
  assert.ok(start>=0,'support ticket detail handler must exist');
  assert.doesNotMatch(handler,/p\.phone|p\.telegram_user_id|p\.instagram_handle|t\.phone|t\.telegram_user_id|t\.instagram_handle/);
  assert.match(handler,/SELECT t\.\*,p\.full_name FROM support_tickets/);
});

test('support ticket detail remains permission-gated through support.read',()=>{
  assert.match(source,/if\(data\.startsWith\('admin:support'\)\)return hasPermission\(id,'support\.read'\)/);
});

test('support priority actions reject stale buttons instead of overwriting a newer priority',()=>{
  assert.match(source,/admin:support:priority:'\+id\+':high:'\+t\.priority/);
  assert.match(source,/admin:support:priority:'\+id\+':urgent:'\+t\.priority/);
  assert.match(source,/admin:support:priority:\\(\\d\+\\):\(low\|normal\|high\|urgent\):\(low\|normal\|high\|urgent\)/);
  assert.match(source,/ticket\.priority!==expectedPriority/);
  assert.match(source,/SELECT id,priority FROM support_tickets WHERE id=\? FOR UPDATE/);
  assert.match(source,/bot\.action\(\/\^admin:support:priority:\\(\\d\+\\):\(low\|normal\|high\|urgent\)\$\//);
});
