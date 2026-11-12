'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const mysql = require('mysql2/promise');

const enabled = Boolean(process.env.MYSQL_TEST_HOST);

test('schema and migrations upgrade a legacy status enum safely', { skip: !enabled }, async () => {
  const database = 'istore_lottery_migration_test';
  const root = await mysql.createConnection({
    host: process.env.MYSQL_TEST_HOST,
    port: Number(process.env.MYSQL_TEST_PORT || 3306),
    user: process.env.MYSQL_TEST_USER || 'root',
    password: process.env.MYSQL_TEST_PASSWORD || 'test-root-password',
    multipleStatements: true
  });

  try {
    await root.query('DROP DATABASE IF EXISTS `' + database + '`');
    await root.query('CREATE DATABASE `' + database + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    const db = await mysql.createConnection({
      host: process.env.MYSQL_TEST_HOST,
      port: Number(process.env.MYSQL_TEST_PORT || 3306),
      user: process.env.MYSQL_TEST_USER || 'root',
      password: process.env.MYSQL_TEST_PASSWORD || 'test-root-password',
      database,
      multipleStatements: true
    });
    try {
      const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
      await db.query(schema);
      await db.query("ALTER TABLE lottery_entries MODIFY status ENUM('active','inactive') NOT NULL DEFAULT 'active'");
    } finally {
      await db.end();
    }

    const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'migrations', 'run.js')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DB_HOST: process.env.MYSQL_TEST_HOST,
        DB_PORT: String(process.env.MYSQL_TEST_PORT || 3306),
        DB_USER: process.env.MYSQL_TEST_USER || 'root',
        DB_PASSWORD: process.env.MYSQL_TEST_PASSWORD || 'test-root-password',
        DB_NAME: database
      },
      timeout: 30000
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.match(run.stdout, /MIGRATIONS_OK/);

    const verify = await mysql.createConnection({
      host: process.env.MYSQL_TEST_HOST,
      port: Number(process.env.MYSQL_TEST_PORT || 3306),
      user: process.env.MYSQL_TEST_USER || 'root',
      password: process.env.MYSQL_TEST_PASSWORD || 'test-root-password',
      database
    });
    try {
      const [[status]] = await verify.execute(
        "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='lottery_entries' AND COLUMN_NAME='status'"
      );
      assert.match(status.COLUMN_TYPE, /'deleted'/);
      const [columns] = await verify.execute(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='lottery_entries'"
      );
      const names = new Set(columns.map(x => x.COLUMN_NAME));
      assert.ok(names.has('deleted_at'));
      assert.ok(names.has('deletion_reason'));
      const [audit] = await verify.execute(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='admin_audit_log'"
      );
      assert.deepEqual(new Set(audit.map(x => x.COLUMN_NAME)), new Set([
        'id', 'admin_id', 'action', 'entity_type', 'entity_id', 'details', 'created_at'
      ]));
    } finally {
      await verify.end();
    }
  } finally {
    await root.query('DROP DATABASE IF EXISTS `' + database + '`');
    await root.end();
  }
});
