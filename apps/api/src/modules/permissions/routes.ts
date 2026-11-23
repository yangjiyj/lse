import type { FastifyInstance } from 'fastify';
import { PERMISSIONS } from '@lse/shared';
import { authenticate } from '../../plugins/auth.js';

export async function permissionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // The permission catalog is the single source of truth for role editing UIs.
  // Not sensitive — any authenticated user may read it.
  app.get('/', async () => {
    const groups: { group: string; items: { code: string; name: string }[] }[] = [];
    const byGroup = new Map<string, { group: string; items: { code: string; name: string }[] }>();
    for (const p of PERMISSIONS) {
      let g = byGroup.get(p.group);
      if (!g) {
        g = { group: p.group, items: [] };
        byGroup.set(p.group, g);
        groups.push(g);
      }
      g.items.push({ code: p.code, name: p.name });
    }
    return { groups, all: PERMISSIONS };
  });
}
