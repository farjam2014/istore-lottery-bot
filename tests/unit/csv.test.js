import test from 'node:test';
import assert from 'node:assert/strict';
import {csvCell,toCsv} from '../../src/shared/csv.js';

test('CSV quotes delimiters, quotes and line breaks',()=>{
  assert.equal(csvCell('Ali, "A"'),'"Ali, ""A"""');
});
test('CSV neutralizes spreadsheet formulas',()=>{
  for(const value of ['=1+1','+SUM(A1:A2)','-2+3','@SUM(A1)','\\t=1+1','\\r=1+1'])assert.ok(csvCell(value).startsWith('"\\''));
});
test('CSV output includes UTF-8 BOM and CRLF rows',()=>{
  assert.equal(toCsv([{name:'test'}],['name']),'\\uFEFFname\\r\\n"test"');
});
