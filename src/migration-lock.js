'use strict';

async function acquireMigrationLock(db, lockName = 'istore_lottery_migrations', timeoutSeconds = 30) {
  if (!db || typeof db.execute !== 'function') throw new TypeError('A MySQL connection is required');
  const [rows] = await db.execute('SELECT GET_LOCK(?, ?) AS acquired', [lockName, timeoutSeconds]);
  if (Number(rows && rows[0] && rows[0].acquired) !== 1) {
    throw new Error('Could not acquire the database migration lock; another migration may be running.');
  }
  let released = false;
  return async function releaseMigrationLock() {
    if (released) return;
    released = true;
    const [releaseRows] = await db.execute('SELECT RELEASE_LOCK(?) AS released', [lockName]);
    if (Number(releaseRows && releaseRows[0] && releaseRows[0].released) !== 1) {
      throw new Error('The database migration lock could not be confirmed as released.');
    }
  };
}

module.exports = { acquireMigrationLock };
