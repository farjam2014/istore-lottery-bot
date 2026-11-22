import test from 'node:test';
import assert from 'node:assert/strict';
import {csvCell,toCsv} from '../../src/shared/csv.js';

test('CSV quotes delimiters and embedded quotes',()=>{
  assert.equal(csvCell('Ali, "A"'),'"Ali, ""A"""');
});
test('CSV neutralizes spreadsheet formulas and control-prefixed formulas',()=>{
  for(const value of ['=1+1','+SUM(A1:A2)','-2+3','@SUM(A1)','\t=1+1','\r=1+1','  =1+1','\n=1+1'])assert.ok(csvCell(value).startsWith('"\''));
});
test('CSV output includes UTF-8 BOM and CRLF rows',()=>{
  assert.equal(toCsv([{name:'test'}],['name']),'\uFEFFname\r\n"test"');
});


test('CSV neutralizes formulas preceded by spaces and control characters',()=>{
  assert.ok(csvCell('   @SUM(A1)').startsWith('"\''));
  assert.ok(csvCell('\u2003=1+1').startsWith('"\''));
  assert.ok(csvCell('\uFEFF=1+1').startsWith('"\''));
  assert.ok(csvCell('\u007F@SUM(A1)').startsWith('"\''));
  assert.ok(csvCell('\u2003+1').startsWith('"\''));
  assert.ok(csvCell('\u0000=1+1').startsWith('"\''));
});
