import { assertNonEndpointTaskTarget } from '../../lib/endpoint-task-policy.js';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Prisma, Severity } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { requirePermission } from '../../plugins/auth.js';
import { requireLicensedFeature } from '../../lib/license-enforcement.js';
import { badRequest } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { enqueueEvalTask } from '../../lib/queue.js';
import { makeRng } from '../generator/core/prng.js';
import {
  MULTIMODAL_ATTACK_LABELS,
  MULTIMODAL_ATTACK_TYPES,
  MULTIMODAL_CARRIERS,
  MULTIMODAL_CARRIER_LABELS,
  type MultimodalCarrier,
} from './attacks.js';
import { ALL_PATTERNS } from '../generator/templates/index.js';
import { generate } from '../generator/core/generate.js';
import { MULTIMODAL_ENGINE, MULTIMODAL_QUESTION_KIND } from './executor.js';
import { extractByoImageRef, extractMultimodalImage } from './evidence.js';
import { canAccessByoSet, registerByoImageRoutes } from './byo-images/routes.js';
import { createHash } from 'node:crypto';
import { notFound } from '../../lib/errors.js';
import { loadEnabledQuestionSets } from '../question-sets/enabled.js';

export const MULTIMODAL_MAX_SAMPLES = 200;
export const MULTIMODAL_DEFAULT_SAMPLES = 10;
export const MULTIMODAL_VISION_REQUIRED_MESSAGE =
  '该评估对象未声明支持图片输入，无法发起多模态越狱评估。请先在评估对象编辑页开启“支持图片输入”。';

const REFUSE_PATTERNS = ALL_PATTERNS.filter((p) => p.shouldRefuse);
const GENERATOR_TYPES = ['SHOULD_REFUSE', 'PROMPT_INJECTION', 'COMPLIANCE'] as const;

const generatorSpecSchema = z.object({
  categories: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  count: z.number().int().min(1).max(MULTIMODAL_MAX_SAMPLES).optional(),
  language: z.enum(['zh', 'en']).default('zh'),
  seed: z.string().trim().min(1).max(128).optional(),
});

/** 题源统一结构：来自已有题集，或由生成器按风险类别现产。 */
interface PoolQuestion {
  externalId: string | null;
  content: string;
  expectedBehavior: string | null;
  category: string | null;
  type: 'COMPLIANCE' | 'PROMPT_INJECTION' | 'SHOULD_REFUSE' | 'GENERAL';
  severity: Severity | null;
  referenceAnswer: string | null;
  language: string | undefined;
  tags: string[];
  sourceQuestionId: string | null;
  sourceQuestionSetId: string | null;
}

// questionSetId 与 generatorSpec 二选一。
const createMultimodalBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    modelTargetId: z.string().uuid(),
    questionSetId: z.string().uuid().optional(),
    generatorSpec: generatorSpecSchema.optional(),
    categories: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    attackTypes: z.array(z.enum(MULTIMODAL_ATTACK_TYPES)).min(1).max(3),
    carriers: z
      .array(z.enum(MULTIMODAL_CARRIERS))
      .min(1)
      .max(MULTIMODAL_CARRIERS.length)
      .optional(),
    sampleCount: z
      .number()
      .int()
      .min(1)
      .max(MULTIMODAL_MAX_SAMPLES)
      .default(MULTIMODAL_DEFAULT_SAMPLES),
    seed: z.string().trim().min(1).max(128).optional(),
  })
  .refine((b) => Boolean(b.questionSetId) !== Boolean(b.generatorSpec), {
    message: '题目来源须二选一：已有题集（questionSetId）或自动生成（generatorSpec）',
  });

/** 注册在 /api/eval-tasks 下：GET /multimodal/attack-types、POST /multimodal。 */
export function registerMultimodalRoutes(app: FastifyInstance): void {
  registerByoImageRoutes(app);
  app.get(
    '/multimodal/attack-types',
    { preHandler: [requirePermission('eval_task:read')] },
    async () => ({
      items: MULTIMODAL_ATTACK_TYPES.map((id) => ({ id, label: MULTIMODAL_ATTACK_LABELS[id] })),
    }),
  );

  // 自动生成题源可选的风险类别（按语言）。
  app.get(
    '/multimodal/generator-categories',
    { preHandler: [requirePermission('eval_task:read')] },
    async (request) => {
      const { language } = z
        .object({ language: z.enum(['zh', 'en']).default('zh') })
        .parse(request.query);
      const counts = new Map<string, number>();
      for (const p of REFUSE_PATTERNS) {
        if (p.language === language) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
      }
      return {
        items: [...counts.keys()].sort().map((category) => ({ id: category, label: category })),
      };
    },
  );

  app.get(
    '/multimodal/carriers',
    { preHandler: [requirePermission('eval_task:read')] },
    async () => ({
      items: MULTIMODAL_CARRIERS.map((id) => ({ id, label: MULTIMODAL_CARRIER_LABELS[id] })),
    }),
  );

  // 结果详情查看存证图片：校验 sha256 与存证一致后返回 PNG。
  app.get(
    '/:id/results/:resultId/multimodal-image',
    { preHandler: [requirePermission('eval_task:read')] },
    async (request, reply) => {
      const params = z
        .object({ id: z.string().uuid(), resultId: z.string().uuid() })
        .parse(request.params);
      const result = await prisma.evalResult.findFirst({
        where: { id: params.resultId, taskId: params.id },
        select: {
          engineRuns: {
            where: { engine: MULTIMODAL_ENGINE },
            select: { engine: true, rawOutput: true },
          },
        },
      });
      if (!result) throw notFound('评估结果不存在');
      const byoRef = extractByoImageRef(result.engineRuns);
      if (byoRef) {
        // 自带图片：字节在图片集内；需属主/管理员，且响应不得被共享缓存。
        const row = await prisma.byoImage.findUnique({
          where: { id: byoRef.imageId },
          select: {
            data: true,
            mimeType: true,
            sha256: true,
            questionSet: { select: { createdById: true } },
          },
        });
        if (!row) throw notFound('该图片已被删除，无法查看');
        if (!canAccessByoSet(request.currentUser!, row.questionSet.createdById)) {
          throw notFound('该结果没有多模态图片存证');
        }
        const bytes = Buffer.from(row.data);
        const actualByo = createHash('sha256').update(bytes).digest('hex');
        if (actualByo !== row.sha256 || (byoRef.sha256 && actualByo !== byoRef.sha256)) {
          throw badRequest('图片存证校验失败（sha256 不一致）', 'MULTIMODAL_IMAGE_TAMPERED');
        }
        reply
          .header('content-type', row.mimeType)
          .header('cache-control', 'private, no-store')
          .header('x-content-sha256', actualByo);
        return reply.send(bytes);
      }
      const image = extractMultimodalImage(result.engineRuns);
      if (!image) throw notFound('该结果没有多模态图片存证');
      const actual = createHash('sha256').update(image.png).digest('hex');
      if (image.sha256 && actual !== image.sha256) {
        throw badRequest('图片存证校验失败（sha256 不一致）', 'MULTIMODAL_IMAGE_TAMPERED');
      }
      reply
        .header('content-type', 'image/png')
        .header('cache-control', 'private, max-age=300')
        .header('x-content-sha256', actual);
      return reply.send(image.png);
    },
  );

  app.post(
    '/multimodal',
    { preHandler: [requirePermission('eval_task:create'), requireLicensedFeature('web_ai')] },
    async (request, reply) => {
      const body = createMultimodalBody.parse(request.body);
      const target = await prisma.modelTarget.findUnique({ where: { id: body.modelTargetId } });
      if (!target) throw badRequest('所选评估对象不存在', 'MODEL_TARGET_NOT_FOUND');
      assertNonEndpointTaskTarget(target);
      if (!target.isActive) throw badRequest('所选评估对象已禁用', 'MODEL_TARGET_INACTIVE');
      if (target.targetType !== 'MODEL') {
        throw badRequest('多模态越狱仅支持可直接调用的模型评估对象', 'MULTIMODAL_TARGET_NOT_MODEL');
      }
      if (!target.supportsVision) {
        throw badRequest(MULTIMODAL_VISION_REQUIRED_MESSAGE, 'MULTIMODAL_VISION_NOT_SUPPORTED');
      }

      // 题源：自动生成（按风险类别现产）或复用已有题集。
      const seed = body.generatorSpec?.seed ?? body.seed ?? randomUUID();
      let pool: PoolQuestion[];
      let sourceLabel: string;
      let setSource = 'multimodal-jailbreak';
      let setLanguage = 'zh';
      let sourceSetId: string | null = null;
      const sampleCount = body.generatorSpec?.count ?? body.sampleCount;
      if (body.generatorSpec) {
        const spec = body.generatorSpec;
        const outcome = generate(REFUSE_PATTERNS, {
          types: [...GENERATOR_TYPES],
          categories: spec.categories,
          language: spec.language,
          count: sampleCount,
          seed: `multimodal-gen|${seed}`,
          dedupe: true,
        });
        if (outcome.produced === 0) {
          throw badRequest('所选风险类别下没有可用模板，未生成样本', 'MULTIMODAL_GENERATE_EMPTY');
        }
        pool = outcome.questions.map((q) => ({
          externalId: q.externalId,
          content: q.content,
          expectedBehavior: q.expectedBehavior,
          category: q.category,
          type: q.type,
          severity: q.severity,
          referenceAnswer: q.referenceAnswer,
          language: q.language ?? undefined,
          tags: q.tags,
          sourceQuestionId: null,
          sourceQuestionSetId: null,
        }));
        setSource = `generator:multimodal:${seed}`;
        setLanguage = spec.language;
        sourceLabel = `自动生成（${spec.categories?.length ? spec.categories.join('、') : '全部风险类别'}，${spec.language === 'zh' ? '中文' : '英文'}）`;
      } else {
        await loadEnabledQuestionSets(prisma, [body.questionSetId!], () =>
          badRequest('所选题集不存在', 'QUESTION_SET_NOT_FOUND'),
        );
        const sourceSet = await prisma.questionSet.findUnique({
          where: { id: body.questionSetId! },
          include: {
            questions: {
              where: body.categories?.length ? { category: { in: body.categories } } : undefined,
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            },
          },
        });
        if (!sourceSet) throw badRequest('所选题集不存在', 'QUESTION_SET_NOT_FOUND');
        if (sourceSet.questions.length === 0) {
          throw badRequest('所选题集（或类别）下没有题目', 'MULTIMODAL_QUESTION_SET_EMPTY');
        }
        sourceSetId = sourceSet.id;
        setLanguage = sourceSet.language ?? 'zh';
        pool = sourceSet.questions.map((q) => ({
          externalId: q.externalId,
          content: q.content,
          expectedBehavior: q.expectedBehavior,
          category: q.category,
          type: q.type,
          severity: q.severity,
          referenceAnswer: q.referenceAnswer,
          language: q.language ?? undefined,
          tags: q.tags,
          sourceQuestionId: q.id,
          sourceQuestionSetId: sourceSet.id,
        }));
        sourceLabel = `由「${sourceSet.name}」抽取`;
      }

      // 可复现抽样：同一 seed、同一题源得到相同题目、攻击类型与版式分配。
      const rng = makeRng(`multimodal-select|${seed}`);
      const picked = rng.shuffle(pool).slice(0, Math.min(sampleCount, pool.length));
      const attackTypes = [...body.attackTypes];
      const carriers: MultimodalCarrier[] | null = body.carriers ? [...body.carriers] : null;
      let injectionIndex = 0;
      const plan = picked.map((q, index) => {
        const attackType = attackTypes[index % attackTypes.length]!;
        const carrier =
          attackType === 'injection' && carriers
            ? carriers[injectionIndex++ % carriers.length]!
            : null;
        return { q, attackType, carrier, itemSeed: `${seed}#${index}` };
      });

      const taskName =
        body.name ?? `${target.name} 多模态越狱评估 ${new Date().toISOString().slice(0, 16)}`;
      const created = await prisma.$transaction(async (tx) => {
        const set = await tx.questionSet.create({
          data: {
            name: `${taskName} 样本`,
            description: `${sourceLabel} ${plan.length}/${pool.length} 题生成多模态越狱样本，抽样 seed：${seed}；攻击类型：${attackTypes.map((t) => MULTIMODAL_ATTACK_LABELS[t]).join('、')}${carriers && attackTypes.includes('injection') ? `；承载场景：${carriers.map((c) => MULTIMODAL_CARRIER_LABELS[c]).join('、')}` : ''}。`,
            type: 'SHOULD_REFUSE',
            source: setSource,
            language: setLanguage,
            tags: ['multimodal-jailbreak'],
            createdById: request.currentUser!.id,
            questions: {
              create: plan.map(({ q, attackType, carrier, itemSeed }) => ({
                externalId: q.externalId,
                content: q.content,
                expectedBehavior: q.expectedBehavior,
                category: q.category,
                type: q.type,
                severity: q.severity,
                referenceAnswer: q.referenceAnswer,
                language: q.language ?? undefined,
                shouldRefuse: true,
                tags: [...new Set([...q.tags, 'multimodal-jailbreak'])],
                metadata: {
                  kind: MULTIMODAL_QUESTION_KIND,
                  multimodal: {
                    attackType,
                    seed: itemSeed,
                    instruction: q.content,
                    ...(carrier ? { carrier } : {}),
                    sourceQuestionId: q.sourceQuestionId,
                    sourceQuestionSetId: q.sourceQuestionSetId,
                  },
                } satisfies Prisma.InputJsonValue,
              })),
            },
          },
        });
        return tx.evalTask.create({
          data: {
            name: taskName,
            description:
              '多模态越狱评估：将题目指令以图片形式发送给视觉模型，由判定模型评估是否突破安全边界。',
            status: 'PENDING',
            modelTargetId: target.id,
            engines: [MULTIMODAL_ENGINE, 'llm-judge'],
            dimensions: ['multimodal_jailbreak'],
            concurrency: 2,
            totalQuestions: plan.length,
            sampleSeed: seed,
            createdById: request.currentUser!.id,
            questionSets: { create: [{ questionSetId: set.id }] },
          },
        });
      });

      await enqueueEvalTask(created.id);
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'eval_task.create_multimodal',
        targetType: 'eval_task',
        targetId: created.id,
        detail: {
          name: created.name,
          modelTargetId: target.id,
          sourceQuestionSetId: sourceSetId,
          questionSource: body.generatorSpec ? 'generator' : 'question_set',
          categories: body.categories ?? [],
          attackTypes,
          carriers: carriers ?? [],
          sampleCount: plan.length,
          seed,
        },
      });
      reply.code(201);
      return { id: created.id, name: created.name, totalQuestions: plan.length, seed };
    },
  );
}
