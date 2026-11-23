import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../db.js';
import { chatComplete } from '../../lib/llm-client.js';
import { writeAudit } from '../../lib/audit.js';
import {
  RAG_QUALITY_TYPES,
  RAG_TESTGEN_PROMPT_VERSION,
  generateQualityItems,
  type RagQualityType,
} from './generator.js';
import { resolveRagJudge, RAG_JUDGE_NOT_CONFIGURED_MESSAGE, type RagChatCaller } from './judge-model.js';
import { RAG_SECURITY_TEMPLATE_VERSION } from './security.js';

export interface RagTestGenJobParams {
  counts: Partial<Record<RagQualityType, number>>;
  includeSecurity: boolean;
}

export interface RunRagTestGenDeps {
  prisma?: PrismaClient;
  chat?: RagChatCaller;
  concurrency?: number;
}

/**
 * 测试集生成（BullMQ 队列 rag-testgen 的处理函数，也可在测试中直接调用）。
 * 进度写入 RagTestSet.generationProgress；用户取消时 generationStatus 置为 CANCELED，这里逐题检查并停止。
 * 安全题在创建测试集时已写入，生成失败不删除测试集，状态记 FAILED 并保留失败原因。
 */
export async function runRagTestSetGeneration(testSetId: string, deps: RunRagTestGenDeps = {}): Promise<void> {
  const db = deps.prisma ?? prisma;
  const chat = deps.chat ?? chatComplete;
  const set = await db.ragTestSet.findUnique({ where: { id: testSetId } });
  if (!set || set.generationStatus !== 'GENERATING') return;
  const stats = (set.generationStats ?? {}) as Record<string, unknown>;
  const params = (stats.params ?? {}) as RagTestGenJobParams;
  const counts = params.counts ?? {};

  const finish = async (
    status: 'READY' | 'FAILED' | 'CANCELED',
    patch: { error?: string | null; stats?: Record<string, unknown> } = {},
  ) => {
    // 已被用户取消的不再覆盖为 READY/FAILED。
    const current = await db.ragTestSet.findUnique({ where: { id: testSetId }, select: { generationStatus: true } });
    const final = current?.generationStatus === 'CANCELED' ? 'CANCELED' : status;
    await db.ragTestSet.update({
      where: { id: testSetId },
      data: {
        generationStatus: final,
        generationError: patch.error ?? null,
        ...(patch.stats ? { generationStats: { ...stats, ...patch.stats } as Prisma.InputJsonValue } : {}),
      },
    });
    await writeAudit({
      actorId: set.createdById,
      action: 'rag_eval.test_set.generate_finish',
      targetType: 'rag_test_set',
      targetId: testSetId,
      detail: { status: final, error: patch.error ?? null, generated: patch.stats?.generated ?? null },
    });
  };

  const judge = await resolveRagJudge(db as never);
  if (!judge) {
    await finish('FAILED', { error: RAG_JUDGE_NOT_CONFIGURED_MESSAGE });
    return;
  }
  const chunks = await db.ragChunk.findMany({
    where: { corpusId: set.corpusId },
    orderBy: [{ documentId: 'asc' }, { seq: 'asc' }],
    select: { id: true, documentId: true, seq: true, content: true },
  });
  if (chunks.length === 0) {
    await finish('FAILED', { error: '知识库中还没有文档切块，请先在第 2 步上传文档' });
    return;
  }
  const existing = await db.ragTestItem.findMany({ where: { testSetId }, select: { question: true } });

  let lastWrite = 0;
  let result;
  try {
    result = await generateQualityItems({
      chunks,
      counts,
      seed: set.seed,
      judge,
      chat,
      concurrency: deps.concurrency ?? 4,
      existingQuestions: existing.map((e) => e.question),
      onProgress: async (p) => {
        const now = Date.now();
        if (p.done !== p.planned && now - lastWrite < 500) return;
        lastWrite = now;
        await db.ragTestSet.update({
          where: { id: testSetId },
          data: { generationProgress: p as unknown as Prisma.InputJsonValue },
        });
      },
      isCanceled: async () => {
        const s = await db.ragTestSet.findUnique({ where: { id: testSetId }, select: { generationStatus: true } });
        return s?.generationStatus === 'CANCELED';
      },
    });
  } catch (err) {
    await finish('FAILED', { error: `生成异常：${(err as Error).message}` });
    return;
  }

  if (result.items.length > 0) {
    await db.ragTestItem.createMany({
      data: result.items.map((i) => ({
        testSetId,
        type: i.type,
        question: i.question,
        referenceAnswer: i.referenceAnswer,
        sourceChunkIds: i.sourceChunkIds,
        origin: 'GENERATED',
        metadata: i.metadata as Prisma.InputJsonValue,
      })),
    });
  }
  const genStats = {
    requested: counts,
    generated: RAG_QUALITY_TYPES.reduce<Record<string, number>>((acc, t) => {
      acc[t] = result.items.filter((i) => i.type === t).length;
      return acc;
    }, {}),
    failures: result.failures.slice(0, 50),
    notes: result.notes,
    rejected: result.rejected,
    promptVersion: RAG_TESTGEN_PROMPT_VERSION,
    securityTemplateVersion: RAG_SECURITY_TEMPLATE_VERSION,
    includeSecurity: params.includeSecurity,
    judgeModel: judge.name,
  };
  await db.ragTestSet.update({ where: { id: testSetId }, data: { judgeModelName: judge.name } });
  if (result.canceled) {
    await finish('CANCELED', { stats: genStats });
    return;
  }
  const requested = RAG_QUALITY_TYPES.reduce((n, t) => n + (counts[t] ?? 0), 0);
  if (requested > 0 && result.items.length === 0) {
    const first = result.failures[0]?.error ?? result.notes[0] ?? '未知原因';
    await finish('FAILED', { error: `评估模型未能生成任何题目：${first}`, stats: genStats });
    return;
  }
  await finish('READY', { stats: genStats });
}
