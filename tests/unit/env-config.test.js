import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvironment } from '../../src/config/env.js';

const validEnvironment = {
  BOT_TOKEN:'x'.repeat(40),
  MYSQL_HOST: '127.0.0.1',
  MYSQL_DATABASE: 'istore_lottery',
  MYSQL_USER: 'ustorebot',
  MYSQL_PASSWORD: 'test-password'
};

test('environment schema preserves production defaults under Zod 4', () => {
  const result = parseEnvironment({ ...validEnvironment });
  assert.equal(result.success, true);
  assert.equal(result.data.NODE_ENV, 'production');
  assert.equal(result.data.MYSQL_PORT, 3306);
  assert.equal(result.data.MYSQL_POOL_SIZE, 10);
  assert.equal(result.data.LOG_LEVEL, 'info');
  assert.equal(result.data.BOT_ADMIN_IDS, '');
});

test('environment schema coerces a valid MySQL port and pool size', () => {
  const result = parseEnvironment({
    ...validEnvironment,
    MYSQL_PORT: '3307',
    MYSQL_POOL_SIZE: '15'
  });
  assert.equal(result.success, true);
  assert.equal(result.data.MYSQL_PORT, 3307);
  assert.equal(result.data.MYSQL_POOL_SIZE, 15);
});

test('environment schema rejects invalid numeric settings', () => {
  const result = parseEnvironment({
    ...validEnvironment,
    MYSQL_PORT: 'not-a-port',
    MYSQL_POOL_SIZE: '51'
  });
  assert.equal(result.success, false);
  assert.ok(result.error.flatten().fieldErrors.MYSQL_PORT);
  assert.ok(result.error.flatten().fieldErrors.MYSQL_POOL_SIZE);
});

test('environment schema rejects invalid database identifiers and missing token', () => {
  const result = parseEnvironment({
    ...validEnvironment,
    BOT_TOKEN: 'short',
    MYSQL_DATABASE: 'invalid-name'
  });
  assert.equal(result.success, false);
  assert.ok(result.error.flatten().fieldErrors.BOT_TOKEN);
  assert.ok(result.error.flatten().fieldErrors.MYSQL_DATABASE);
});
