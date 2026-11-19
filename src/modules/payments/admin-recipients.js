export function normalizeAdminIds(adminIds) {
  if (adminIds == null) return [];
  if (adminIds instanceof Set || Array.isArray(adminIds)) {
    return [...adminIds].map(String).filter(Boolean);
  }
  if (typeof adminIds === 'string') {
    return adminIds.split(',').map(value => value.trim()).filter(Boolean);
  }
  return [String(adminIds)];
}
