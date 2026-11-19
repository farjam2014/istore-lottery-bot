import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const startHandler=readFileSync(new URL('../../src/bot/handlers/start.handler.js',import.meta.url),'utf8');

test('/start resumes an awaiting-phone registration with the contact-share keyboard',()=>{
  assert.match(startHandler,/s\.step==='awaiting_phone'[\s\S]*?phoneShareKeyboard\(\)/);
  assert.doesNotMatch(startHandler,/s\.step==='awaiting_phone'[\s\S]*?cancelKeyboard\(\)/);
});
