"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createWebhookQueue } = require("../src/webhook-queue");
const { getCorrelationId } = require("../src/correlation-context");

function createHarness({ handler, finishAffectedRows = 1, heartbeatFailure = false, alreadyProcessed = false, heartbeatMs = 60 * 60 * 1000, correlationId = null, rateLimit = async () => ({ limited: false, allowed: true }) } = {}) {
  const calls = [];
  const logs = [];
  let connectionCount = 0;
  let rateLimitDecision = false;
  const statements = [];

  const item = {
    update_id: "9001",
    correlation_id: correlationId,
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
      async execute(sql, params = []) {
        statements.push({kind,sql,params});
        calls.push(`${kind}:execute:${sql.includes("status='done'") ? "finish" : "other"}`);

        if (sql.includes('SELECT retry_after_ms FROM webhook_rate_limit_events')) {
          return [rateLimitDecision ? [{retry_after_ms:3000}] : [], []];
        }
        if (sql.includes('INSERT INTO webhook_rate_limit_events')) {
          rateLimitDecision = true;
          return [{affectedRows:1}, []];
        }
        if (sql.includes('DELETE FROM webhook_rate_limit_events')) {
          rateLimitDecision = false;
          return [{affectedRows:1}, []];
        }

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
        return [alreadyProcessed ? [{ update_id: item.update_id }] : [], []];
      }

      if (heartbeatFailure && sql.includes("SET processing_started_at=NOW()")) {
        throw new Error("simulated heartbeat database failure");
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
    rateLimit,
    handlers: {
      business: handler || (async () => {})
    },
    logger,
    heartbeatMs
  });

  return { queue, calls, logs, statements };
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

test("rate-limited webhook is delayed without consuming attempts and rechecked until allowed",async()=>{
 let checks=0,handled=0;
 const decisions=[{limited:true,retryAfterMs:3000},{limited:false,retryAfterMs:0}];
 const {queue,statements}=createHarness({
  rateLimit:async()=>{checks++;return decisions.shift();},
  handler:async()=>{handled++;}
 });
 assert.equal(await queue.processOne(),false);
 assert.equal(checks,1);
 assert.equal(handled,0);
 assert.ok(statements.some(x=>x.sql.includes("SET received_at=DATE_ADD(NOW(3)")));
 assert.ok(statements.some(x=>x.sql.includes("INSERT INTO webhook_rate_limit_events")));
 assert.equal(statements.some(x=>x.sql.includes("SET status='processing'")),false);
 assert.equal(await queue.processOne(),true);
 assert.equal(checks,2,'deferred updates must be checked again against the active quota');
 assert.equal(handled,1);
 assert.ok(statements.some(x=>x.sql.includes("DELETE FROM webhook_rate_limit_events")));
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
  const { queue, calls, logs } = createHarness({ finishAffectedRows: 0 });

  const result = await queue.processOne();

  assert.equal(result, false);
  assert.ok(calls.includes("finish:rollback"));
  assert.ok(logs.some(line => line.includes("token was lost")));
});

test("heartbeat database failure prevents webhook finalization", async () => {
  const { queue, calls, logs } = createHarness({
    heartbeatFailure: true,
    heartbeatMs: 5,
    handler: async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  });

  const result = await queue.processOne();

  assert.equal(result, false);
  assert.ok(logs.some(line => line.includes("heartbeat database failure")));
  assert.ok(logs.some(line => line.includes("processing lease was lost")));
  assert.ok(!calls.includes("finish:execute:finish"));
});

test("a second poll cannot process while the first handler is running", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { queue } = createHarness({
    handler: async () => { await gate; }
  });

  const first = queue.processOne();
  const second = await queue.processOne();
  assert.equal(second, false);

  release();
  assert.equal(await first, true);
});

test("stop waits for an in-flight webhook handler", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { queue } = createHarness({
    handler: async () => { await gate; }
  });

  const processing = queue.processOne();
  let stopped = false;
  const stopping = queue.stop().then(() => { stopped = true; });

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(stopped, false);

  release();
  await Promise.all([processing, stopping]);
  assert.equal(stopped, true);
});


test("stop returns false instead of waiting forever after its deadline", async () => {
  const { queue } = createHarness({
    handler: async () => { await new Promise(resolve => setTimeout(resolve, 80)); }
  });
  const processing = queue.processOne();
  const stopped = await queue.stop(10);
  assert.equal(stopped, false);
  await processing;
});


test("webhook handler receives the durable correlation id from inbox", async () => {
  const id="123e4567-e89b-42d3-a456-426614174000";
  let observed=null;
  const {queue}=createHarness({correlationId:id,handler:async()=>{observed=getCorrelationId();}});
  assert.equal(await queue.processOne(),true);
  assert.equal(observed,id);
  assert.equal(getCorrelationId(),null);
});

test("already processed update ids are not sent to business handlers again", async () => {
  let handled = 0;
  const { queue, calls } = createHarness({
    alreadyProcessed: true,
    handler: async () => { handled += 1; }
  });
  assert.equal(await queue.processOne(), true);
  assert.equal(handled, 0);
  assert.ok(calls.includes("finish:execute:finish"));
  assert.ok(calls.includes("finish:commit"));
});
