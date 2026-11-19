import test from 'node:test';
import assert from 'node:assert/strict';
import {formatTehranDateTime,formatTehranDate,parseJalaliDateTime,parseUtcDateTime} from '../src/shared/datetime.js';

test('parses Persian and Arabic digits and converts Tehran local time to UTC',()=>{
  assert.equal(parseJalaliDateTime('۱۴۰۵/۰۹/۰۱ ۱۸:۳۰'),'2026-11-22 15:00:00');
  assert.equal(parseJalaliDateTime('١٤٠٥/٠٩/٠١ ١٨:٣٠'),'2026-11-22 15:00:00');
});
test('validates Jalali leap day through the Persian calendar',()=>{
  assert.equal(parseJalaliDateTime('۱۴۰۳/۱۲/۳۰ ۱۲:۰۰'),'2025-03-20 08:30:00');
  assert.throws(()=>parseJalaliDateTime('۱۴۰۴/۱۲/۳۰ ۱۲:۰۰'),/تقویم شمسی معتبر/);
});
test('formats UTC database values in Persian calendar and Tehran time',()=>{
  const value=formatTehranDateTime('2026-11-22 15:00:00');
  assert.match(value,/۱۴۰۵/);
  assert.match(value,/۰۹/);
  assert.match(value,/۱۸:۳۰/);
  assert.equal(formatTehranDate('2026-11-22 15:00:00'),'۱۴۰۵/۰۹/۰۱');
});
test('parses MySQL DATETIME explicitly as UTC and rejects invalid values',()=>{
  assert.equal(parseUtcDateTime('2026-11-22 15:00:00').toISOString(),'2026-11-22T15:00:00.000Z');
  assert.throws(()=>parseUtcDateTime('2026-02-30 15:00:00'));
  assert.equal(formatTehranDateTime(null),'—');
});
