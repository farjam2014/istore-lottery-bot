import {config} from '../src/config/env.js';
import {assertMigrationAllowed} from '../src/database/migration-guard.js';
import {migrate} from '../src/database/migrate.js';
import {pool} from '../src/database/pool.js';
import {closeMigrationPool} from '../src/database/migration-pool.js';
import {logger} from '../src/shared/logger.js';

try {
  assertMigrationAllowed({database:config.MYSQL_DATABASE,nodeEnv:config.NODE_ENV,host:config.MYSQL_HOST});
  await migrate();
  logger.info('Schema applied');
} catch (error) {
  logger.error({err:error},'Migration refused or failed');
  process.exitCode=1;
} finally {
  await closeMigrationPool();
  await pool.end();
}
