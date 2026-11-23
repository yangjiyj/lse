import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { getBuiltinTaxonomy, type LlmTargetConfig } from '@lse/shared';
import { prisma } from '../../../db.js';
import { requirePermission } from '../../../plugins/auth.js';
import { conflict } from '../../../lib/errors.js';
import { writeAudit } from '../../../lib/audit.js';
import { requireLicensedFeature } from '../../../lib/license-enforcement.js';
import { chatComplete } from '../../../lib/llm-client.js';
import { resolveServerTargetEgressContext } from '../../../lib/target-egress-policy.js';
import { RED_TEAM_SETTING_KEY } from '../../red-team/config.js';
import { asSystem } from '../../../lib/tenant-context.js';
import { attackSeedSpecSchema, MAX_QUESTIONS_PER_SCENARIO, MAX_SCENARIOS } from './core.js';
import { generateAttackSeeds, type SeedChatCaller } from './llm.js';

/** 可替换依赖（测试用 mock 攻击模型）。 */
export const attackSeedDeps: { chat: SeedChatCaller } = { chat: chatComplete };

const domainBody = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
});
const saveBody = z.object({
  name: z.string().trim().min(1).max(200),
  spec: attackSeedSpecSchema,
  source: z.enum(['attacker_model', 'template']),
  scenarios: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        description: z.string().max(500).default(''),
        category: z.string().nullable().default(null),
        questions: z.array(z.string().trim().min(1).max(2000)).max(MAX_QUESTIONS_PER_SCENARIO),
      }),
    )
    .min(1)
    .max(MAX_SCENARIOS),
});

/** 读取「对抗评估配置」中的主攻击模型（attackerTargetId），未配置或未启用返回 null。 */
async function loadAttacker(): Promise<{ cfg: LlmTargetConfig; name: string } | null> {
  const setting = await prisma.systemSetting.findUnique({ where: { key: RED_TEAM_SETTING_KEY } });
  const id = String((setting?.value as Record<string, unknown> | null)?.attackerTargetId ?? '');
  if (!id) return null;
  // 攻击模型来自「平台设置」，属于平台租户：用 asSystem 跨租户读，否则租户里查不到、攻击模型被静默关掉。
  const t = await asSystem(async () => await prisma.modelTarget.findUnique({ where: { id } }));
  if (!t || !t.isActive) return null;
  return {
    name: t.name,
    cfg: {
      baseUrl: t.baseUrl,
      apiKey: t.apiKey,
      model: t.model,
      extraHeaders: (t.extraHeaders as Record<string, string> | null) ?? null,
      defaultParams: (t.defaultParams as Record<string, unknown> | null) ?? null,
      egressContext: resolveServerTargetEgressContext(),
    },
  };
}

async function ensureDomain(name: string, userId: string) {
  // 唯一键是 (tenantId, name)：先在本租户可见范围里找，找不到再建；不能用 name 做 upsert。
  const existing = await prisma.testDomain.findFirst({ where: { name } });
  if (existing) return existing;
  return prisma.testDomain.create({ data: { name, createdById: userId } });
}

export async function attackSeedRoutes(app: FastifyInstance): Promise<void> {
  const guard = (perm: string) => ({
    preHandler: [requirePermission(perm), requireLicensedFeature('web_ai')],
  });

  app.get(
    '/attack-seeds/domains',
    { preHandler: [requirePermission('question_set:read')] },
    async () => {
      const items = await prisma.testDomain.findMany({ orderBy: { createdAt: 'asc' } });
      return { items: items.map((d) => ({ id: d.id, name: d.name, description: d.description })) };
    },
  );

  app.post('/attack-seeds/domains', guard('generator:run'), async (request, reply) => {
    const body = domainBody.parse(request.body);
    if (await prisma.testDomain.findFirst({ where: { name: body.name } })) {
      throw conflict('测试领域已存在');
    }
    const d = await prisma.testDomain.create({
      data: { ...body, createdById: request.currentUser!.id },
    });
    await writeAudit({
      actorId: request.currentUser!.id,
      actorName: request.currentUser!.username,
      action: 'test_domain.create',
      targetType: 'test_domain',
      targetId: d.id,
      detail: { name: d.name },
    });
    reply.code(201);
    return { id: d.id, name: d.name, description: d.description };
  });

  app.post('/attack-seeds/generate', guard('generator:run'), async (request) => {
    const spec = attackSeedSpecSchema.parse(request.body);
    const attacker = await loadAttacker();
    const result = await generateAttackSeeds(spec, attacker?.cfg ?? null, attackSeedDeps.chat);
    const total = result.scenarios.reduce((a, s) => a + s.questions.length, 0);
    await writeAudit({
      actorId: request.currentUser!.id,
      actorName: request.currentUser!.username,
      action: 'attack_seed.generate',
      targetType: 'question_set',
      targetId: null,
      detail: {
        domain: spec.domain,
        scenarioCount: spec.scenarioCount,
        questionsPerScenario: spec.questionsPerScenario,
        binding: spec.binding,
        source: result.source,
        fallbackReason: result.fallbackReason ?? null,
        total,
      },
    });
    return {
      ...result,
      attackerModel: result.source === 'attacker_model' ? attacker!.name : null,
      total,
    };
  });

  app.post('/attack-seeds/save', guard('question_set:create'), async (request, reply) => {
    const body = saveBody.parse(request.body);
    if (await prisma.questionSet.findFirst({ where: { name: body.name } })) {
      throw conflict('样本库名称已存在');
    }
    const userId = request.currentUser!.id;
    const domain = await ensureDomain(body.spec.domain, userId);
    const tax = body.spec.binding ? getBuiltinTaxonomy(body.spec.binding.taxonomy) : undefined;
    const metadata = {
      kind: 'attack_seed',
      domain: { id: domain.id, name: domain.name },
      scope: body.spec.scope,
      focus: body.spec.focus,
      keywords: body.spec.keywords,
      binding: body.spec.binding ? { ...body.spec.binding, name: tax?.name ?? null } : null,
      generationSource: body.source,
      scenarios: body.scenarios.map((s) => ({
        name: s.name,
        description: s.description,
        category: s.category,
        questionCount: s.questions.length,
      })),
    };
    const questions = body.scenarios.flatMap((s, si) =>
      s.questions.map((content) => ({ content, scenario: s, si })),
    );
    const set = await prisma.$transaction(async (tx) => {
      const created = await tx.questionSet.create({
        data: {
          name: body.name,
          description: `攻击种子泛化：${domain.name}${tax ? ` · 绑定 ${tax.name}` : ''}`,
          type: 'SHOULD_REFUSE',
          tags: ['攻击种子泛化', domain.name, ...(tax ? [tax.name] : [])],
          source: 'attack-seed',
          language: 'zh',
          metadata: metadata as unknown as Prisma.InputJsonValue,
          createdById: userId,
        },
      });
      await tx.question.createMany({
        data: questions.map((q) => ({
          questionSetId: created.id,
          content: q.content,
          category: q.scenario.category,
          type: 'SHOULD_REFUSE' as const,
          shouldRefuse: true,
          language: 'zh',
          tags: ['攻击种子泛化', q.scenario.name],
          metadata: {
            scenario: q.scenario.name,
            scenarioIndex: q.si,
            generationSource: body.source,
          },
        })),
      });
      return created;
    });
    await writeAudit({
      actorId: userId,
      actorName: request.currentUser!.username,
      action: 'attack_seed.save',
      targetType: 'question_set',
      targetId: set.id,
      detail: {
        name: set.name,
        domain: domain.name,
        questionCount: questions.length,
        source: body.source,
      },
    });
    reply.code(201);
    return { id: set.id, name: set.name, questionCount: questions.length };
  });
}
