import test from 'node:test';
import assert from 'node:assert/strict';
import {getCorrelationId,withCorrelation} from '../src/shared/request-context.js';

test('correlation context is available through awaited async work',async()=>{
  assert.equal(getCorrelationId(),null);
  await withCorrelation('update-123',async()=>{
    assert.equal(getCorrelationId(),'update-123');
    await Promise.resolve();
    assert.equal(getCorrelationId(),'update-123');
  });
  assert.equal(getCorrelationId(),null);
});

test('concurrent async contexts remain isolated',async()=>{
  const values=await Promise.all([
    withCorrelation('first',async()=>{await new Promise(resolve=>setImmediate(resolve));return getCorrelationId();}),
    withCorrelation('second',async()=>{await Promise.resolve();return getCorrelationId();})
  ]);
  assert.deepEqual(values,['first','second']);
});
