export function assertMigrationAllowed({database,nodeEnv,env=process.env}={}) {
  const name=String(database ?? '');
  const environment=String(nodeEnv ?? 'production');

  if (env.ALLOW_DATABASE_MIGRATIONS !== '1') {
    throw new Error(
      'Database migrations are disabled by default. Set ALLOW_DATABASE_MIGRATIONS=1 only for an explicitly approved migration run.'
    );
  }

  if (environment === 'test' && !/_ci$|_test$/i.test(name)) {
    throw new Error(
      'Test-environment migrations are restricted to databases ending in _ci or _test.'
    );
  }

  if (environment === 'production') {
    if (env.ALLOW_PRODUCTION_MIGRATIONS !== '1') {
      throw new Error(
        'Production migrations require ALLOW_PRODUCTION_MIGRATIONS=1 in addition to ALLOW_DATABASE_MIGRATIONS=1.'
      );
    }
    if (!name || env.MIGRATION_TARGET_DATABASE !== name) {
      throw new Error(
        'Production migration target mismatch. MIGRATION_TARGET_DATABASE must exactly match MYSQL_DATABASE.'
      );
    }
  }
}
