"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createWebhookQueue } = require("../src/webhook-queue");

function createHarness({ handler, finishAffectedRows = 1 } = {}) {
  const calls = [];
  const logs = [];
  let connectionCount = 0;

  const item = {
    update_id: "9001",
    payload: { business_message: { text: "لاتاری" } }
  };

  function makeConnection(kind) {
    return {
      async beginTransaction() {
        calls.push(`${kind}:begin`);
      },
      async commit() {
        calls.push(`${kind}:commit`);
      },
      async rollback() {
        calls.push(`${kind}:rollback`);
      },
      release() {
        calls.push(`${kind}:release`);
      },
      async query(sql) {
        calls.push(`${kind}:query`);
        if (sql.includes("SELECT update_id,payload")) {
          return [[item], []];
        }
        throw new Error("Unexpected connection query");
      },
      async execute(sql) {
        calls.push(`${kind}:execute:${sql.includes("status='done'") ? "finish" : "other"}`);

        if (sql.includes("status='done'")) {
          return [{ affectedRows: finishAffectedRows }, []];
        }

        return [{ affectedRows: 1 }, []];
      }
    };
  }

  const db = {
    async getConnection() {
      connectionCount += 1;
      return makeConnection(connectionCount === 1 ? "claim" : "finish");
    },

    async execute(sql) {
      calls.push(`db:execute:${sql.includes("SELECT 1 FROM processed_updates") ? "processed-check" : "retry-or-heartbeat"}`);

      if (sql.includes("SELECT 1 FROM processed_updates")) {
        return [[], []];
      }

      return [{ affectedRows: 1 }, []];
    }
  };

  const logger = {
    error(...args) {
      logs.push(args.join(" "));
    }
  };

  const queue = createWebhookQueue({
    db,
    handlers: {
      business: handler || (async () => {})
    },
    logger,
    heartbeatMs: 60 * 60 * 1000
  });

  return { queue, calls, logs };
}

test("successful update is handled and marked done", async () => {
  let handled = 0;
  const { queue, calls } = createHarness({
    handler: async () => {
      handled += 1;
    }
  });

  const result = await queue.processOne();

  assert.equal(result, true);
  assert.equal(handled, 1);
  assert.ok(calls.includes("finish:execute:finish"));
  assert.ok(calls.includes("finish:commit"));
});

test("handler failure does not mark update done and schedules retry", async () => {
  const { queue, calls, logs } = createHarness({
    handler: async () => {
      throw new Error("simulated handler failure");
    }
  });

  const result = await queue.processOne();

  assert.equal(result, false);
  assert.ok(logs.some(line => line.includes("simulated handler failure")));
  assert.ok(calls.includes("db:execute:retry-or-heartbeat"));
  assert.ok(!calls.includes("finish:execute:finish"));
});

test("lost processing token prevents finalization", async () => {
  const { queue, calls } = createHarness({ finishAffectedRows: 0 });

  const result = await queue.processOne();

  assert.equal(result, false);
  assert.ok(!calls.includes("finish:execute:other"));
});
