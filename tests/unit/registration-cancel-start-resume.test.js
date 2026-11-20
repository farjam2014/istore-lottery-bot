import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const startHandler=readFileSync(new URL('../../src/bot/handlers/start.handler.js',import.meta.url),'utf8');

test('/start resumes an awaiting-phone registration with the contact-share keyboard',()=>{
  assert.match(startHandler,/if\(s\.step==='awaiting_phone'\)\s*\{\s*return ctx\.reply\([^;]*phoneShareKeyboard\(\)\);\s*\}/);
});
