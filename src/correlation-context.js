'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const storage = new AsyncLocalStorage();
const PATCHED = Symbol('istoreCorrelationPatched');
const TARGETS = new Set(['telegram_notification_outbox','admin_audit_log','payment_orders','payment_order_card_deliveries']);

function getCorrelationId() {
  return storage.getStore()?.correlationId || null;
}

function runWithCorrelation(correlationId, callback) {
  const id = String(correlationId || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new TypeError('A UUID correlation id is required');
  return storage.run({ correlationId: id }, callback);
}

function injectCorrelation(sql, values, correlationId) {
  if (!correlationId || !Array.isArray(values) || typeof sql !== 'string') return { sql, values };
  const match = sql.match(/^(INSERT(?:\s+IGNORE)?\s+INTO\s+`?([a-z0-9_]+)`?\s*)\(([^)]+)\)(\s*VALUES\s*)\(([^)]+)\)/i);
  if (!match || !TARGETS.has(match[2].toLowerCase())) return { sql, values };
  if (/(^|,)\s*`?correlation_id`?\s*(,|$)/i.test(match[3])) return { sql, values };
  const updated = sql.replace(match[0], match[1] + '(' + match[3] + ',correlation_id)' + match[4] + '(' + match[5] + ',?)');
  return { sql: updated, values: [...values, correlationId] };
}

function patchExecutor(target, method) {
  const original = target[method];
  if (typeof original !== 'function' || original[PATCHED]) return;
  const bound = original.bind(target);
  const wrapped = function(sql, values, ...rest) {
    const enriched = injectCorrelation(sql, values, getCorrelationId());
    return bound(enriched.sql, enriched.values, ...rest);
  };
  wrapped[PATCHED] = true;
  target[method] = wrapped;
}

function bindConnection(connection) {
  if (!connection || connection[PATCHED]) return connection;
  patchExecutor(connection, 'execute');
  patchExecutor(connection, 'query');
  Object.defineProperty(connection, PATCHED, { value: true });
  return connection;
}

function bindPool(pool) {
  if (!pool || pool[PATCHED]) return pool;
  patchExecutor(pool, 'execute');
  patchExecutor(pool, 'query');
  if (typeof pool.getConnection === 'function') {
    const original = pool.getConnection.bind(pool);
    pool.getConnection = async function(...args) {
      return bindConnection(await original(...args));
    };
  }
  Object.defineProperty(pool, PATCHED, { value: true });
  return pool;
}

module.exports = { getCorrelationId, runWithCorrelation, bindPool, injectCorrelation };
