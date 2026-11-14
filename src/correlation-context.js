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

function findMatchingParen(source, openIndex) {
  let depth = 0, quote = null, escaped = false;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) {
        if (source[i + 1] === quote) { i++; continue; }
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '\x60') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

function injectCorrelation(sql, values, correlationId) {
  if (!correlationId || !Array.isArray(values) || typeof sql !== 'string') return { sql, values };
  const insert = sql.match(/^(INSERT(?:\s+IGNORE)?\s+INTO\s+[\x60]?([a-z0-9_]+)[\x60]?\s*)\(/i);
  if (!insert || !TARGETS.has(insert[2].toLowerCase())) return { sql, values };

  const columnsOpen = insert[0].length - 1;
  const columnsClose = findMatchingParen(sql, columnsOpen);
  if (columnsClose < 0) return { sql, values };
  const columns = sql.slice(columnsOpen + 1, columnsClose);
  if (columns.split(',').some(column => column.trim().replace(/[\x60"]/g, '').toLowerCase() === 'correlation_id')) return { sql, values };

  const valuesClause = sql.slice(columnsClose + 1).match(/^\s*VALUES\s*\(/i);
  if (!valuesClause) return { sql, values };
  const valuesOpen = columnsClose + 1 + valuesClause[0].lastIndexOf('(');
  const valuesClose = findMatchingParen(sql, valuesOpen);
  if (valuesClose < 0) return { sql, values };

  const withColumn = sql.slice(0, columnsClose) + ',correlation_id' + sql.slice(columnsClose);
  const closeAfterColumn = valuesClose + ',correlation_id'.length;
  const updated = withColumn.slice(0, closeAfterColumn) + ',?' + withColumn.slice(closeAfterColumn);
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
