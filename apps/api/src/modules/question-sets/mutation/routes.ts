// 种子 → 变异扩展 → 新自有样本库。
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { LANGUAGE, type Language, type Severity } from '@lse/shared';
import { prisma } from '../../../db.js';
import { requirePermission } from '../../../plugins/auth.js';
import { badRequest, conflict, notFound } from '../../../lib/errors.js';
import { writeAudit } from '../../../lib/audit.js';
import { requireLicensedFeature } from '../../../lib/license-enforcement.js';
import type { GeneratedQuestion } from '../../generator/core/types.js';
import { enhance } from '../../generator/enhance/enhance.js';
import {
  buildEnhanceConfigFromEnv,
  createEnhanceLlmClient,
  isEnhanceConfigured,
  type EnhanceLlmClient,
} from '../../generator/enhance/llm-client.js';
import {
  LLM_STRATEGIES,
  MAX_OUTPUT,
  MAX_SAMPLE_SIZE,
  MAX_STRATEGIES,
  applyRuleStrategy,
  chooseStrategies,
  isKnownStrategy,
  isLlmStrategy,
  listStrategies,
  pickOffsets,
  randomSeed,
  strategyLabel,
} from './core.js';

/** 可替换依赖（测试用 mock 改写模型）；默认读 ENHANCE_LLM_* 环境变量。 */
export const mutationDeps: { getLlmClient: () => EnhanceLlmClient | null } = {
  getLlmClient: () => {
    const cfg = buildEnhanceConfigFromEnv(process.env);
    return isEnhanceConfigured(cfg) ? createEnhanceLlmClient(cfg) : null;
  },
};

const mutationBody = z.object({
  sourceSetId: z.string().uuid(),
  sampleSize: z.number().int().min(1).max(MAX_SAMPLE_SIZE),
  seed: z.string().trim().min(1).max(64).optional(),
  strategies: z.array(z.string().trim().min(1)).min(1).max(MAX_STRATEGIES),
  perSeed: z.number().int().min(1).max(MAX_STRATEGIES).default(1),
  name: z.string().trim().min(1).max(100),
});

const ID_PAGE = 5000;
const FETCH_BATCH = 200;
const INSERT_BATCH = 500;

/** 按 id 升序分页只取 id，命中偏移集合的才保留；全程不把整库载入内存。 */
async function sampleIds(setId: string, offsets: number[]): Promise<string[]> {
  const want = new Set(offsets);
  const ids: string[] = [];
  let cursor: string | undefined;
  let index = 0;
  const last = offsets[offsets.length - 1] ?? -1;
  while (index <= last) {
    const page = await prisma.question.findMany({
      where: { questionSetId: setId },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: ID_PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (page.length === 0) break;
    for (const row of page) {
      if (want.has(index)) ids.push(row.id);
      index += 1;
    }
    cursor = page[page.length - 1]!.id;
  }
  return ids;
}

export async function mutationRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/mutation/strategies',
    { preHandler: [requirePermission('question_set:read')] },
    async () => ({
      items: listStrategies(),
      llmConfigured: mutationDeps.getLlmClient() !== null,
      limits: {
        maxSampleSize: MAX_SAMPLE_SIZE,
        maxStrategies: MAX_STRATEGIES,
        maxOutput: MAX_OUTPUT,
      },
    }),
  );

  app.post(
    '/mutation',
    { preHandler: [requirePermission('question_set:create'), requireLicensedFeature('web_ai')] },
    async (request, reply) => {
      const body = mutationBody.parse(request.body);
      const strategies = [...new Set(body.strategies)];
      const unknown = strategies.filter((s) => !isKnownStrategy(s));
      if (unknown.length) throw badRequest(`存在未知的变换策略：${unknown.join('、')}`);
      if (body.perSeed > strategies.length) throw badRequest('每题策略数不能超过所选策略数');
      if (body.sampleSize * body.perSeed > MAX_OUTPUT) {
        throw badRequest(`单次产出不能超过 ${MAX_OUTPUT} 题，请减小抽样数或每题策略数`);
      }
      const needLlm = strategies.some(isLlmStrategy);
      const llm = needLlm ? mutationDeps.getLlmClient() : null;
      if (needLlm && !llm) throw badRequest('所选策略需要大模型改写，请先配置改写模型');

      const source = await prisma.questionSet.findUnique({ where: { id: body.sourceSetId } });
      if (!source) throw notFound('源样本库不存在');
      if (await prisma.questionSet.findFirst({ where: { name: body.name } })) {
        throw conflict('样本库名称已存在');
      }
      const total = await prisma.question.count({ where: { questionSetId: source.id } });
      if (total === 0) throw badRequest('源样本库没有题目');

      const seed = body.seed ?? randomSeed();
      const offsets = pickOffsets(total, body.sampleSize, seed);
      const ids = await sampleIds(source.id, offsets);

      const rows: Prisma.QuestionCreateManyInput[] = [];
      const perStrategy = new Map<string, number>(strategies.map((s) => [s, 0]));
      let skipped = 0;

      for (let i = 0; i < ids.length; i += FETCH_BATCH) {
        const batch = await prisma.question.findMany({
          where: { id: { in: ids.slice(i, i + FETCH_BATCH) } },
          orderBy: { id: 'asc' },
        });
        for (const q of batch) {
          for (const sid of chooseStrategies(strategies, body.perSeed, seed, q.id)) {
            let content: string | null;
            let extraTags: string[] = [];
            if (isLlmStrategy(sid)) {
              const mode = LLM_STRATEGIES.find((s) => s.id === sid)!.mode;
              const gq: GeneratedQuestion = {
                content: q.content,
                type: q.type,
                category: q.category ?? '',
                language: ((LANGUAGE as readonly string[]).includes(q.language)
                  ? q.language
                  : 'zh') as Language,
                severity: (q.severity ?? 'MEDIUM') as Severity,
                shouldRefuse: q.shouldRefuse,
                expectedBehavior: q.expectedBehavior,
                referenceAnswer: q.referenceAnswer,
                tags: [],
                externalId: q.id,
                variantId: sid,
                riskDomain: 'prompt_injection',
              };
              const r = await enhance([gq], {
                spec: { mode, intensity: 2 },
                client: llm,
                configured: true,
              });
              content = r.stats.applied === 1 ? r.questions[0]!.content : null;
              extraTags = ['gen:llm'];
            } else {
              content = applyRuleStrategy(q.content, q.language, sid, seed, q.id);
            }
            if (content === null) {
              skipped += 1;
              continue;
            }
            const base =
              q.metadata && typeof q.metadata === 'object' && !Array.isArray(q.metadata)
                ? (q.metadata as Record<string, unknown>)
                : {};
            rows.push({
              questionSetId: '',
              content,
              expectedBehavior: q.expectedBehavior,
              category: q.category,
              type: q.type,
              severity: q.severity,
              referenceAnswer: q.referenceAnswer,
              language: q.language,
              shouldRefuse: q.shouldRefuse,
              tags: [...new Set([...q.tags, 'mutation', `mutation:${sid}`, ...extraTags])],
              metadata: {
                ...base,
                mutation: {
                  parentQuestionId: q.id,
                  parentSetId: source.id,
                  strategy: sid,
                  seed,
                },
              } as Prisma.InputJsonValue,
            });
            perStrategy.set(sid, (perStrategy.get(sid) ?? 0) + 1);
          }
        }
      }
      if (rows.length === 0) throw badRequest('所选策略对抽到的种子题都不适用，没有产出新题');

      const set = await prisma.questionSet.create({
        data: {
          name: body.name,
          description: `由「${source.name}」按种子 ${seed} 抽样 ${ids.length} 题、套用 ${strategies
            .map(strategyLabel)
            .join('、')} 变异扩展而成`,
          type: source.type,
          language: source.language,
          tags: [...new Set([...source.tags, '变异扩展'])],
          source: `mutation:${source.id}:${seed}`,
          isBuiltin: false,
          createdById: request.currentUser!.id,
          metadata: {
            mutation: {
              sourceSetId: source.id,
              sourceSetName: source.name,
              sampleSize: body.sampleSize,
              seed,
              strategies,
              perSeed: body.perSeed,
              produced: rows.length,
              skipped,
            },
          } as Prisma.InputJsonValue,
        },
      });
      try {
        for (let i = 0; i < rows.length; i += INSERT_BATCH) {
          await prisma.question.createMany({
            data: rows.slice(i, i + INSERT_BATCH).map((r) => ({ ...r, questionSetId: set.id })),
          });
        }
      } catch (err) {
        await prisma.questionSet.delete({ where: { id: set.id } }).catch(() => undefined);
        throw err;
      }

      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'question_set.mutation',
        targetType: 'question_set',
        targetId: set.id,
        detail: {
          name: set.name,
          sourceSetId: source.id,
          seed,
          sampleSize: body.sampleSize,
          sampled: ids.length,
          strategies,
          perSeed: body.perSeed,
          produced: rows.length,
          skipped,
        },
      });
      reply.code(201);
      return {
        id: set.id,
        name: set.name,
        seed,
        sourceTotal: total,
        sampled: ids.length,
        total: rows.length,
        skipped,
        perStrategy: strategies.map((id) => ({
          id,
          label: strategyLabel(id),
          count: perStrategy.get(id) ?? 0,
        })),
      };
    },
  );
}
