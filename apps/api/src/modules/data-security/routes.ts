import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../lib/audit.js';
import { loadDataSecurity } from '../../lib/data-security.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';

export const VIEW_PLAIN_PERMISSION = 'sensitive_data:view_plain';

const revealBody = z
  .object({
    /** 敏感信息类型：手机号、身份证号、邮箱、银行卡号、姓名。 */
    kind: z.enum(['phone', 'id_card', 'email', 'bank_card', 'name']),
    /** 所在页面/字段，如 users.email、answer.content。 */
    field: z.string().trim().min(1).max(80),
    targetType: z.string().trim().min(1).max(40).optional(),
    targetId: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

/**
 * 数据安全消费端：
 * - GET  /api/data-security        已登录用户读取脱敏/水印开关（前端据此默认脱敏、叠加页面水印）
 * - POST /api/data-security/reveal 「查看明文」前置校验：需 sensitive_data:view_plain 权限，并写审计
 * 修改开关走 /api/system-settings（data_security 分组，平台设置权限 + 审计）。
 */
export async function dataSecurityRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get('/', async (request) => {
    const settings = await loadDataSecurity();
    return {
      ...settings,
      canViewPlain: request.currentUser!.permissions.has(VIEW_PLAIN_PERMISSION),
    };
  });

  app.post(
    '/reveal',
    { preHandler: [requirePermission(VIEW_PLAIN_PERMISSION)] },
    async (request) => {
      const body = revealBody.parse(request.body);
      const ua = request.headers['user-agent'];
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'sensitive_data.reveal',
        targetType: body.targetType ?? null,
        targetId: body.targetId ?? null,
        ip: request.ip,
        userAgent: typeof ua === 'string' ? ua : null,
        detail: { kind: body.kind, field: body.field },
      });
      return { ok: true };
    },
  );
}
