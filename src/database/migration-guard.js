export function assertMigrationAllowed({database,nodeEnv,host,env=process.env}={}) {
  const name=String(database ?? '');
  const environment=String(nodeEnv ?? 'production');

  if (!['development','test','production'].includes(environment)) {
    throw new Error('Unsupported NODE_ENV for database migrations.');
  }

  if (env.ALLOW_DATABASE_MIGRATIONS !== '1') {
    throw new Error(
      'Database migrations are disabled by default. Set ALLOW_DATABASE_MIGRATIONS=1 only for an explicitly approved migration run.'
    );
  }

  if (environment === 'test') {
    if (env.ALLOW_TEST_DATABASE_MIGRATIONS !== '1') {
      throw new Error(
        'Test-environment migrations require ALLOW_TEST_DATABASE_MIGRATIONS=1.'
      );
    }
    if (!/_ci$|_test$/i.test(name)) {
      throw new Error(
        'Test-environment migrations are restricted to databases ending in _ci or _test.'
      );
    }
    const normalizedHost=String(host ?? '').trim().toLowerCase();
    if (!['127.0.0.1','localhost','::1'].includes(normalizedHost)) {
      throw new Error(
        'Test-environment migrations are restricted to loopback database hosts.'
      );
    }
    return;
  }

  if (env.ALLOW_PRODUCTION_MIGRATIONS !== '1') {
    throw new Error(
      'Non-test database migrations require ALLOW_PRODUCTION_MIGRATIONS=1 in addition to ALLOW_DATABASE_MIGRATIONS=1.'
    );
  }
  if (!name || env.MIGRATION_TARGET_DATABASE !== name) {
    throw new Error(
      'Non-test migration target mismatch. MIGRATION_TARGET_DATABASE must exactly match MYSQL_DATABASE.'
    );
  }
}
