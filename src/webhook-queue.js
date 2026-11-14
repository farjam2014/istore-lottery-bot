"use strict";
const crypto = require("node:crypto");
const { runWithCorrelation } = require("./correlation-context");

function createWebhookQueue({ db, handlers, logger = console, pollInterval = 500, leaseMs = 5 * 60 * 1000, heartbeatMs = 60 * 1000 }) {
  if (!db || !handlers) throw new Error("db and handlers are required");

  let busy = false;
  let timer = null;

  async function processOne() {
    if (busy) return false;
    busy = true;

    let item = null;
    let heartbeat = null;
    let leaseLost = false;

    try {
      const conn = await db.getConnection();

      try {
        await conn.beginTransaction();

        await conn.execute(
          "UPDATE webhook_inbox SET status=IF(attempts>=5,'failed','pending'),received_at=IF(attempts>=5,received_at,DATE_ADD(NOW(),INTERVAL LEAST(300,POW(2,attempts)) SECOND)),processing_started_at=NULL,processing_token=NULL,last_error='Processing lease expired; reclaimed' WHERE status='processing' AND processing_started_at IS NOT NULL AND processing_started_at < DATE_SUB(NOW(),INTERVAL ? MICROSECOND)",
          [leaseMs * 1000]
        );

        const [rows] = await conn.query(
          "SELECT update_id,payload,correlation_id FROM webhook_inbox WHERE status='pending' AND received_at<=NOW() ORDER BY received_at,update_id LIMIT 1 FOR UPDATE SKIP LOCKED"
        );

        if (!rows.length) {
          await conn.commit();
          return false;
        }

        item = rows[0];
        item.processingToken = crypto.randomUUID();
        item.correlationId = item.correlation_id || crypto.randomUUID();

        await conn.execute(
          "UPDATE webhook_inbox SET status='processing',attempts=attempts+1,processing_started_at=NOW(),processing_token=?,correlation_id=COALESCE(correlation_id,?) WHERE update_id=? AND status='pending'",
          [item.processingToken, item.correlationId, item.update_id]
        );

        await conn.commit();
      } catch (error) {
        await conn.rollback();
        throw error;
      } finally {
        conn.release();
      }

      heartbeat = setInterval(async () => {
        try {
          const [result] = await db.execute(
            "UPDATE webhook_inbox SET processing_started_at=NOW() WHERE update_id=? AND status='processing' AND processing_token=?",
            [item.update_id, item.processingToken]
          );
          if (result.affectedRows !== 1) leaseLost = true;
        } catch (error) {
          leaseLost = true;
          logger.error("Webhook lease heartbeat error ["+(item?.correlationId||item?.update_id||"unknown")+"]:", error.message);
        }
      }, heartbeatMs);

      heartbeat.unref?.();

      await runWithCorrelation(item.correlationId, async () => {
        const [alreadyProcessed] = await db.execute(
          "SELECT 1 FROM processed_updates WHERE update_id=? LIMIT 1",
          [item.update_id]
        );

        if (!alreadyProcessed.length) {
          const update = typeof item.payload === "string"
            ? JSON.parse(item.payload)
            : item.payload;

          if (update.business_message && handlers.business) {
            await handlers.business(update);
          } else if (update.message && handlers.private) {
            await handlers.private(update);
          } else if (update.callback_query && handlers.callback) {
            await handlers.callback(update.callback_query);
          }
        }
      });

      if (leaseLost) throw new Error("Webhook processing lease was lost");

      const finish = await db.getConnection();

      try {
        await finish.beginTransaction();

        const [result] = await finish.execute(
          "UPDATE webhook_inbox SET status='done',processed_at=NOW(),processing_started_at=NULL,processing_token=NULL,last_error=NULL WHERE update_id=? AND status='processing' AND processing_token=?",
          [item.update_id, item.processingToken]
        );

        if (result.affectedRows === 1) {
          await finish.execute(
            "INSERT IGNORE INTO processed_updates(update_id) VALUES(?)",
            [item.update_id]
          );
        }

        if (result.affectedRows !== 1) {
          await finish.rollback();
          throw new Error("Webhook processing token was lost before finalization");
        }

        await finish.commit();
        return true;
      } catch (error) {
        await finish.rollback();
        throw error;
      } finally {
        finish.release();
      }
    } catch (error) {
      logger.error("Webhook processing error ["+(item?.correlationId||item?.update_id||"unclaimed")+"]:", error.message);

      if (item?.processingToken) {
        await db.execute(
          "UPDATE webhook_inbox SET status=IF(attempts>=5,'failed','pending'),received_at=IF(attempts>=5,received_at,DATE_ADD(NOW(),INTERVAL LEAST(300,POW(2,attempts)) SECOND)),processing_started_at=NULL,processing_token=NULL,last_error=? WHERE update_id=? AND status='processing' AND processing_token=?",
          [
            String(error.message || "Unknown error").slice(0, 500),
            item.update_id,
            item.processingToken
          ]
        ).catch(updateError => logger.error("Queue update error ["+(item?.correlationId||item?.update_id||"unknown")+"]:", updateError.message));
      }

      return false;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      busy = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      processOne().catch(error => logger.error("Queue worker error:", error.message));
    }, pollInterval);
    timer.unref?.();
  }

  async function stop(timeoutMs = 30000) {
    if (timer) clearInterval(timer);
    timer = null;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (busy && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return !busy;
  }

  return { processOne, start, stop };
}

module.exports = { createWebhookQueue };
