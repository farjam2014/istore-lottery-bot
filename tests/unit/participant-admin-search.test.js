import test from 'node:test';
import assert from 'node:assert/strict';
import {buildParticipantSearch,normalizeParticipantSearchDigits,paginateParticipantResults} from '../../src/modules/participants/participant-admin-search.js';

test('participant search normalizes Persian and Arabic digits',()=>{
  assert.equal(normalizeParticipantSearchDigits('۰۹۱۲٣٤٥٦٧٨٩٠'),'091234567890');
});

test('participant search accepts national phone format against canonical +98 storage',()=>{
  const search=buildParticipantSearch('09121234567');
  assert.ok(search.params.includes('%+989121234567%'));
});

test('participant search accepts @instagram handles stored without @',()=>{
  const search=buildParticipantSearch('@UStore.Shop');
  assert.ok(search.params.includes('%UStore.Shop%'));
});

test('participant search escapes SQL LIKE wildcards and escape characters',()=>{
  const search=buildParticipantSearch('a!b%_c');
  assert.ok(search.params.includes('%a!!b!%!_c%'));
});

test('participant pagination clamps stale and invalid page numbers',()=>{
  assert.deepEqual(paginateParticipantResults(99,17),{page:2,pages:3,offset:16,total:17,limit:8});
  assert.deepEqual(paginateParticipantResults(-3,17),{page:0,pages:3,offset:0,total:17,limit:8});
  assert.deepEqual(paginateParticipantResults('bad',0),{page:0,pages:1,offset:0,total:0,limit:8});
});
