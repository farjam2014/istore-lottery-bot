'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { wrapAsyncHandler, patchAsyncRoutes, createErrorMiddleware } = require('../src/async-route');
const { acquireMigrationLock } = require('../src/migration-lock');

test('async route rejections are forwarded to Express next', async () => {
  const expected = new Error('database unavailable');
  let forwarded;
  const handler = wrapAsyncHandler(async () => { throw expected; });
  await handler({}, {}, error => { forwarded = error; });
  assert.equal(forwarded, expected);
});

test('synchronous route exceptions are forwarded to Express next', async () => {
  const expected = new Error('sync failure');
  let forwarded;
  wrapAsyncHandler(() => { throw expected; })({}, {}, error => { forwarded = error; });
  await Promise.resolve();
  assert.equal(forwarded, expected);
});

test('all supported Express route methods wrap their handlers', async () => {
  const methods = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all'];
  const app = {};
  for (const method of methods) app[method] = function(path, ...handlers) { this.last = { path, handlers }; return this; };
  patchAsyncRoutes(app);
  const handler = async () => 'ok';
  app.post('/test', handler);
  assert.notEqual(app.last.handlers[0], handler);
  assert.equal(await app.last.handlers[0]({}, {}, error => { throw error; }), 'ok');
});

test('error middleware returns a safe 500 response without leaking details', () => {
  let logged, status, body;
  const middleware = createErrorMiddleware({ error: (...values) => { logged = values.join(' '); } });
  const res = { headersSent: false, status(value) { status = value; return this; }, json(value) { body = value; return value; } };
  middleware(new Error('secret SQL detail'), {}, res, () => {});
  assert.equal(status, 500);
  assert.deepEqual(body, { error: 'خطای داخلی سرور.' });
  assert.match(logged, /secret SQL detail/);
});

test('migration lock is acquired and released exactly once', async () => {
  const calls = [];
  const db = { async execute(sql, params) { calls.push([sql, params]); return [[{ acquired: 1, released: 1 }]]; } };
  const release = await acquireMigrationLock(db, 'test_lock', 12);
  await release();
  await release();
  assert.equal(calls.length, 2);
  assert.match(calls[0][0], /GET_LOCK/);
  assert.match(calls[1][0], /RELEASE_LOCK/);
});

test('migration aborts when another process owns the lock', async () => {
  const db = { async execute() { return [[{ acquired: 0 }]]; } };
  await assert.rejects(acquireMigrationLock(db, 'test_lock', 1), /another migration may be running/);
});


test('Express integration converts a rejected async route into a safe HTTP 500', async () => {
  const app = express();
  patchAsyncRoutes(app);
  app.get('/async-failure', async () => { throw new Error('private database detail'); });
  app.use(createErrorMiddleware({ error: () => {} }));
  const server = app.listen(0);
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/async-failure`);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'خطای داخلی سرور.' });
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('a second migration process cannot enter until the first releases its lock', async () => {
  let held = false;
  const makeConnection = () => ({
    async execute(sql) {
      if (sql.includes('GET_LOCK')) {
        if (held) return [[{ acquired: 0 }]];
        held = true;
        return [[{ acquired: 1 }]];
      }
      if (sql.includes('RELEASE_LOCK')) {
        held = false;
        return [[{ released: 1 }]];
      }
      throw new Error('Unexpected SQL');
    }
  });
  const first = await acquireMigrationLock(makeConnection(), 'shared_lock', 1);
  await assert.rejects(acquireMigrationLock(makeConnection(), 'shared_lock', 1), /another migration may be running/);
  await first();
  const second = await acquireMigrationLock(makeConnection(), 'shared_lock', 1);
  await second();
});
