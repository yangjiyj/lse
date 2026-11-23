import { readFileSync, statSync } from 'node:fs';

// Operator-owned configuration binds authenticated LSE accounts to platform tenants.
// Body/query/source metadata never creates or updates an authorization binding.
export function platformTenantForUser(userId: string): string | null {
  const path = process.env.LSE_PLATFORM_TENANT_BINDINGS_FILE;
  if (!path) return null;
  try {
    if ((statSync(path).mode & 0o077) !== 0) return null;
    const raw = readFileSync(path, 'utf8');
    if (raw.length > 65536) return null;
    const bindings = JSON.parse(raw) as Record<string, unknown>;
    const tenant = Object.prototype.hasOwnProperty.call(bindings, userId) ? bindings[userId] : null;
    return typeof tenant === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(tenant) ? tenant : null;
  } catch { return null; }
}
