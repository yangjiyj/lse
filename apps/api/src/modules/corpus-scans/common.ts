import type { FastifyRequest } from 'fastify';
import { writeAudit } from '../../lib/audit.js';

/** 语料扫描、语料规则的审计：记操作人、IP 和 user-agent。 */
export function auditCorpus(
  req: FastifyRequest,
  action: string,
  targetType: string,
  targetId: string | null,
  detail?: unknown,
): Promise<void> {
  const ua = req.headers['user-agent'];
  return writeAudit({
    actorId: req.currentUser!.id,
    actorName: req.currentUser!.username,
    action,
    targetType,
    targetId,
    ip: req.ip,
    userAgent: typeof ua === 'string' ? ua : null,
    detail,
  });
}
