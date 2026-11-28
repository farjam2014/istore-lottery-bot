import test from 'node:test';
import assert from 'node:assert/strict';
import {isStaleTelegramUpdate} from '../../src/shared/telegram-update-cursor.js';

test('rejects updates older than or equal to the session-start cursor',()=>{
  assert.equal(isStaleTelegramUpdate(100,101),true);
  assert.equal(isStaleTelegramUpdate(101,101),true);
});

test('accepts only a later safe Telegram update ID',()=>{
  assert.equal(isStaleTelegramUpdate(102,101),false);
  assert.equal(isStaleTelegramUpdate(Number.MAX_SAFE_INTEGER+1,101),true);
  assert.equal(isStaleTelegramUpdate(undefined,101),true);
  assert.equal(isStaleTelegramUpdate(102,null),true);
});
