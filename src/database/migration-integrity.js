export function assertMigrationHistoryIntegrity(appliedVersions,sourceVersions){
  const source=new Set(sourceVersions.map(String));
  const missing=[...new Set(appliedVersions.map(String))].filter(version=>!source.has(version)).sort();
  if(missing.length)throw new Error('Applied migrations are missing from source: '+missing.join(', ')+'. Restore the exact migration files before running migrations.');
  return true;
}
