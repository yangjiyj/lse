import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { requirePermission } from '../../../plugins/auth.js';
import { prisma } from '../../../db.js';
import { writeAudit } from '../../../lib/audit.js';
import { badRequest } from '../../../lib/errors.js';
import { fuzzVariants } from './fuzz.js';
import { loadCustomRiskRules } from './engine.js';
import {
  CUSTOM_RISK_SETTING_KEY,
  PRESET_CUSTOM_RISK_RULES,
  customRiskSettingSchema,
} from './rules.js';

const fuzzBody = z.object({
  ruleIds: z.array(z.string()).max(50).optional(),
  /** 填写后把原始示例 + 模糊变体导入为新的自有题库（应拒答），用于对抗性模糊评估。 */
  questionSetName: z.string().trim().min(1).max(200).optional(),
});

/** 自定义风险内容：规则配置 + 对抗性模糊变体生成。挂在 /api/engines/custom-risks（父级已做认证）。 */
export async function registerCustomRiskRoutes(scope: FastifyInstance): Promise<void> {
  scope.get(
    '/custom-risks',
    { preHandler: [requirePermission('system_setting:read', 'redteam_setting:read')] },
    async () => ({ items: await loadCustomRiskRules(prisma), presets: PRESET_CUSTOM_RISK_RULES }),
  );

  scope.put(
    '/custom-risks',
    { preHandler: [requirePermission('system_setting:update', 'redteam_setting:update')] },
    async (request) => {
      const parsed = customRiskSettingSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest(parsed.error.issues[0]?.message ?? '自定义风险内容配置不合法');
      }
      const value = parsed.data as unknown as Prisma.InputJsonValue;
      const userId = request.currentUser!.id;
      await prisma.systemSetting.upsert({
        where: { key: CUSTOM_RISK_SETTING_KEY },
        update: { value, updatedById: userId },
        create: { key: CUSTOM_RISK_SETTING_KEY, value, updatedById: userId },
      });
      await writeAudit({
        actorId: userId,
        actorName: request.currentUser!.username,
        action: 'custom_risk.update',
        targetType: 'system_setting',
        targetId: CUSTOM_RISK_SETTING_KEY,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        detail: {
          count: parsed.data.items.length,
          enabled: parsed.data.items.filter((i) => i.enabled).map((i) => i.id),
        },
      });
      return { items: parsed.data.items };
    },
  );

  scope.post(
    '/custom-risks/fuzz',
    { preHandler: [requirePermission('question:create')] },
    async (request, reply) => {
      const body = fuzzBody.parse(request.body ?? {});
      const rules = (await loadCustomRiskRules(prisma)).filter(
        (r) => !body.ruleIds || body.ruleIds.includes(r.id),
      );
      const items = rules.flatMap((rule) =>
        rule.examples.flatMap((example) => [
          {
            ruleId: rule.id,
            ruleName: rule.name,
            severity: rule.severity,
            transform: null,
            label: '原始示例',
            content: example,
          },
          ...fuzzVariants(example).map((v) => ({
            ruleId: rule.id,
            ruleName: rule.name,
            severity: rule.severity,
            transform: v.transform,
            label: v.label,
            content: v.content,
          })),
        ]),
      );
      if (items.length === 0) throw badRequest('所选规则没有可用于生成的示例');
      if (!body.questionSetName) return { items, questionSetId: null };

      const userId = request.currentUser!.id;
      const set = await prisma.questionSet.create({
        data: {
          name: body.questionSetName,
          description:
            '由自定义风险内容示例生成的对抗性模糊评估题目（大小写 / 同音 / 拆字 / 编码）。',
          type: 'SHOULD_REFUSE',
          source: 'custom-risk-fuzz',
          language: 'zh',
          tags: ['custom-risk-fuzz'],
          createdById: userId,
        },
      });
      await prisma.question.createMany({
        data: items.map((item) => ({
          questionSetId: set.id,
          content: item.content,
          category: `custom_risk:${item.ruleId}`,
          type: 'SHOULD_REFUSE' as const,
          severity: item.severity,
          shouldRefuse: true,
          language: 'zh',
          tags: ['custom-risk-fuzz', item.transform ?? 'original'],
          metadata: { source: 'custom-risk-fuzz', ruleId: item.ruleId, transform: item.transform },
        })),
      });
      await writeAudit({
        actorId: userId,
        actorName: request.currentUser!.username,
        action: 'custom_risk.fuzz_import',
        targetType: 'question_set',
        targetId: set.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        detail: { ruleIds: rules.map((r) => r.id), count: items.length },
      });
      reply.code(201);
      return { items, questionSetId: set.id };
    },
  );
}
