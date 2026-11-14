'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const mysql = require('mysql2/promise');

const enabled = Boolean(process.env.MYSQL_TEST_HOST);

test('fresh database bootstrap creates only the normalized multi-campaign schema', { skip: !enabled }, async () => {
  const database = 'ustore_fresh_schema_test';
  assert.ok(process.env.MYSQL_TEST_USER, 'MYSQL_TEST_USER is required');
  assert.ok(process.env.MYSQL_TEST_PASSWORD, 'MYSQL_TEST_PASSWORD is required');

  const adminDb = await mysql.createConnection({
    host: process.env.MYSQL_TEST_HOST,
    port: Number(process.env.MYSQL_TEST_PORT || 3306),
    user: process.env.MYSQL_TEST_USER,
    password: process.env.MYSQL_TEST_PASSWORD
  });
  try {
    await adminDb.query('DROP DATABASE IF EXISTS `' + database + '`');
    await adminDb.query('CREATE DATABASE `' + database + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
  } finally { await adminDb.end(); }

  const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'migrations', 'run.js')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DB_HOST: process.env.MYSQL_TEST_HOST,
      DB_PORT: String(process.env.MYSQL_TEST_PORT || 3306),
      DB_USER: process.env.MYSQL_TEST_USER,
      DB_PASSWORD: process.env.MYSQL_TEST_PASSWORD,
      DB_NAME: database
    },
    timeout: 60000
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /MIGRATIONS_OK/);

  const verify = await mysql.createConnection({
    host: process.env.MYSQL_TEST_HOST,
    port: Number(process.env.MYSQL_TEST_PORT || 3306),
    user: process.env.MYSQL_TEST_USER,
    password: process.env.MYSQL_TEST_PASSWORD,
    database
  });
  try {
    const [tables] = await verify.execute(
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()'
    );
    const names = new Set(tables.map(x => x.TABLE_NAME));
    for (const name of [
      'participants','campaigns','campaign_entries','campaign_codes','payment_orders',
      'payment_receipts','payment_transactions','campaign_capacity_reservations',
      'campaign_payment_sessions','campaign_draws','draw_candidates','draw_winners',
      'draw_evidence','telegram_sessions','telegram_notification_outbox','webhook_inbox',
      'admin_audit_log','processed_updates','customer_support_tickets','bank_cards','web_accounts',
      'password_reset_requests','account_reset_tokens','telegram_contact_gate'
    ]) assert.ok(names.has(name), 'missing normalized table: ' + name);
    for (const name of [
      'lottery_entries','lottery_settings','lottery_draws','lottery_draw_participants',
      'lottery_code_history','released_codes','legacy_entry_mappings','lottery_sessions'
    ]) assert.equal(names.has(name), false, 'legacy table must not be created: ' + name);

    const [[campaignColumns]] = await verify.execute(
      "SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='campaigns' AND COLUMN_NAME='current_payment_card_id'"
    );
    assert.equal(Number(campaignColumns.total), 1);
    const [[sessionColumns]] = await verify.execute(
      "SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='telegram_sessions' AND COLUMN_NAME='step'"
    );
    assert.equal(Number(sessionColumns.total), 1);
    const [[ticketColumns]] = await verify.execute(
      "SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_support_tickets' AND COLUMN_NAME='status'"
    );
    assert.equal(Number(ticketColumns.total), 1);
    const [[ticketMessageColumns]] = await verify.execute(
      "SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_support_tickets' AND COLUMN_NAME='telegram_message_id'"
    );
    assert.equal(Number(ticketMessageColumns.total), 1);
    const [[ticketMessageIndexes]] = await verify.execute(
      "SELECT COUNT(DISTINCT INDEX_NAME) AS total FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_support_tickets' AND INDEX_NAME='uq_support_telegram_message'"
    );
    assert.equal(Number(ticketMessageIndexes.total), 1);
    const [[profileMessageColumns]] = await verify.execute(
      "SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='profile_change_requests' AND COLUMN_NAME='telegram_message_id'"
    );
    assert.equal(Number(profileMessageColumns.total), 1);
    const [[profileMessageIndexes]] = await verify.execute(
      "SELECT COUNT(DISTINCT INDEX_NAME) AS total FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='profile_change_requests' AND INDEX_NAME='uq_profile_change_telegram_message'"
    );
    assert.equal(Number(profileMessageIndexes.total), 1);
  } finally {
    await verify.end();
    const cleanup = await mysql.createConnection({
      host: process.env.MYSQL_TEST_HOST,
      port: Number(process.env.MYSQL_TEST_PORT || 3306),
      user: process.env.MYSQL_TEST_USER,
      password: process.env.MYSQL_TEST_PASSWORD
    });
    try { await cleanup.query('DROP DATABASE IF EXISTS `' + database + '`'); }
    finally { await cleanup.end(); }
  }
});
