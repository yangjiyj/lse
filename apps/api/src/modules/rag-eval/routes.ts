import { checkRagTarget, checkRagJudge } from './check.js';
import { cancelRagEvalRun } from './cancel.js';
import { assertNonEndpointTaskTarget } from '../../lib/endpoint-task-policy.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { parse as parseCsv } from 'csv-parse/sync';
import { prisma } from '../../db.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { csvCell, restoreFormula } from '../../lib/tabular-export.js';
import { requireLicensedFeature } from '../../lib/license-enforcement.js';
import { chatComplete } from '../../lib/llm-client.js';
import { enqueueEvalTask, enqueueRagTestGen, requestEvalTaskCancel } from '../../lib/queue.js';
import { decryptCredential } from '../../lib/credential-crypto.js';
import {
  RagExtractError,
  chunkText,
  detectFormat,
  extractDocumentText,
  sha256Hex,
  RAG_DOCUMENT_MAX_BYTES,
} from './extract.js';
import { RAG_ITEM_TYPES, RAG_QUALITY_TYPES, RAG_TESTGEN_PROMPT_VERSION } from './generator.js';
import {
  POISON_DOCUMENT_FILENAME,
  RAG_SECURITY_TEMPLATE_VERSION,
  SENTINEL_DOCUMENT_FILENAME,
  buildSecurityFixtures,
} from './security.js';
import {
  RAG_JUDGE_NOT_CONFIGURED_MESSAGE,
  RAG_JUDGE_SETTINGS_PATH,
  resolveRagJudge,
  type RagChatCaller,
} from './judge-model.js';
import { RAG_ALIGNMENT_LABEL, RAG_EVAL_ENGINE, runRagEvaluation } from './executor.js';
import {
  RAG_ALIGNMENT_MODES,
  isRagEligibleType,
  readStoredRagOptions,
  testKnowledgeBaseId,
  type RagAlignmentMode,
  type RagOptions,
} from './options.js';
import { computeRagGroupMetrics, computeRagTypeMetrics } from './metrics.js';
import { buildTestPackage, zipTestPackage } from './test-package.js';
import { runRagTestSetGeneration } from './testgen-job.js';
import { isNearDuplicate } from './text-search.js';
import { redactMarkers, stripSensitiveMetadata, testSetMarkers } from './redact.js';

export interface RagEvalRoutesOptions {
  /** 测试注入：评估模型调用器（生成与判定）。 */
  chat?: RagChatCaller;
  /** 发起评估后的调度；默认入队 eval-tasks（worker 按 RagEvalRun 分发）。 */
  dispatchRun?: (taskId: string) => Promise<void>;
  /** 测试集生成调度；默认入队 rag-testgen（worker 执行 runRagTestSetGeneration）。 */
  dispatchTestGen?: (testSetId: string) => Promise<void>;
  /** 取消运行；默认写取消标记。 */
  cancelRun?: (taskId: string) => Promise<void>;
}

const idParams = z.object({ id: z.string().uuid() });
const itemParams = z.object({ id: z.string().uuid(), itemId: z.string().uuid() });

const corpusBody = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).optional(),
});

const uploadBody = z.object({
  filename: z.string().trim().min(1).max(255),
  contentBase64: z
    .string()
    .min(1)
    .max(Math.ceil(RAG_DOCUMENT_MAX_BYTES / 3) * 4 + 4, '文件超过 10MB 上限'),
});

const alignmentMode = z.enum(RAG_ALIGNMENT_MODES);
const countSchema = z.coerce.number().int().min(0).max(100);
const generateBody = z.object({
  name: z.string().trim().min(1).max(100),
  seed: z.string().trim().min(1).max(100).optional(),
  alignmentMode: alignmentMode.default('KB_EXISTING'),
  counts: z
    .object({ FACT: countSchema, MULTI_HOP: countSchema, NO_ANSWER: countSchema, DISTRACTOR: countSchema })
    .partial()
    .default({ FACT: 5, MULTI_HOP: 3, NO_ANSWER: 3, DISTRACTOR: 3 }),
  includeSecurity: z.boolean().default(true),
});

const emptySetBody = z.object({
  name: z.string().trim().min(1).max(100),
  alignmentMode: alignmentMode.default('KB_EXISTING'),
  includeSecurity: z.boolean().default(false),
});

const patchSetBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  alignmentMode: alignmentMode.optional(),
});

const itemBody = z.object({
  type: z.enum(RAG_ITEM_TYPES as [string, ...string[]]),
  question: z.string().trim().min(1).max(4000),
  referenceAnswer: z.string().trim().max(8000).nullable().optional(),
  sourceChunkIds: z.array(z.string().uuid()).max(10).default([]),
});
const itemPatch = itemBody.partial();

/** 导入：CSV/JSONL 文本（前端读取文件后提交），最大 2MB、2000 行。 */
const importBody = z.object({
  format: z.enum(['csv', 'jsonl']),
  content: z.string().min(1).max(2 * 1024 * 1024, '导入文件超过 2MB 上限'),
});

export const RAG_IMPORT_FIELDS = ['type', 'question', 'reference_answer', 'source_chunk_ids'] as const;
export const RAG_IMPORT_MAX_ROWS = 2000;

const runBody = z.object({
  testSetId: z.string().uuid(),
  modelTargetId: z.string().uuid(),
  name: z.string().trim().min(1).max(100).optional(),
  /** 模式 A/C：确认“这些文档已在被测系统知识库中并完成索引”。 */
  alignmentConfirmed: z.boolean().default(false),
  /** 模式 B：测试知识库包已手工导入被测系统（未配置上传接口时）。 */
  packageImported: z.boolean().default(false),
  poisonDocumentImported: z.boolean().default(false),
  sentinelDocumentImported: z.boolean().default(false),
});

const resultsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  verdict: z.enum(['PASS', 'FAIL', 'UNKNOWN', 'ERROR']).optional(),
  status: z.enum(['SUCCESS', 'ERROR', 'RESTRICTED']).optional(),
  itemType: z.string().max(40).optional(),
  needsReview: z.enum(['true', 'false']).optional(),
});

function actor(request: FastifyRequest) {
  return { actorId: request.currentUser!.id, actorName: request.currentUser!.username };
}

/** 是否可查看安全测试素材原文（金丝雀、注入标记、哨兵、投毒/哨兵文档）：仅 rag_eval:manage。 */
function canSeeSecurityMaterial(request: FastifyRequest): boolean {
  return request.currentUser!.permissions.has('rag_eval:manage');
}

/** 某测试集的测试标记（只读视图打码用）。 */
async function markersForTestSet(testSetId: string): Promise<string[]> {
  const set = await prisma.ragTestSet.findUnique({
    where: { id: testSetId },
    select: { seed: true, poisonCanary: true, sentinelToken: true, items: { select: { metadata: true } } },
  });
  return set ? testSetMarkers(set, set.items.map((i) => i.metadata)) : [];
}

function json(v: unknown): Prisma.InputJsonValue {
  return v as Prisma.InputJsonValue;
}

async function loadCorpus(id: string) {
  const corpus = await prisma.ragCorpus.findUnique({ where: { id } });
  if (!corpus) throw notFound('知识库不存在');
  return corpus;
}

async function loadTestSet(id: string) {
  const set = await prisma.ragTestSet.findUnique({ where: { id } });
  if (!set) throw notFound('测试集不存在');
  return set;
}

async function assertChunksInCorpus(corpusId: string, ids: string[]) {
  if (ids.length === 0) return;
  const n = await prisma.ragChunk.count({ where: { id: { in: ids }, corpusId } });
  if (n !== new Set(ids).size) throw badRequest('来源块不属于该测试集的知识库');
}

function assertEditable(set: { generationStatus: string }) {
  if (set.generationStatus === 'GENERATING') throw badRequest('测试集正在生成中，请等待完成或先取消生成');
}

/** 被测对象配置检查清单：每项是否就绪、缺什么、影响哪些指标。前端第 4 步与运行页展示。 */
export interface RagConfigCheck {
  key: string;
  label: string;
  ok: boolean;
  required: boolean;
  hint: string;
}

export function ragConfigChecklist(
  t: { targetType: string; isActive: boolean; isRag: boolean; ragOptions: unknown; ragRestrictedUploadSecret: string | null },
  mode: RagAlignmentMode,
): RagConfigCheck[] {
  const rag: RagOptions = readStoredRagOptions(t.ragOptions);
  const hasSecret = Boolean(t.ragRestrictedUploadSecret && decryptCredential(t.ragRestrictedUploadSecret));
  const checks: RagConfigCheck[] = [
    {
      key: 'type',
      label: '对象类型为智能体应用 API（自定义 HTTP）',
      ok: isRagEligibleType(t.targetType),
      required: true,
      hint: '只有智能体应用 API 类对象能读取原始响应中的检索上下文与引用',
    },
    { key: 'isRag', label: '已开启“声明为 RAG 应用”', ok: t.isRag, required: true, hint: '在评估对象编辑页的 RAG 配置分组中开启' },
    { key: 'active', label: '对象已启用', ok: t.isActive, required: true, hint: '停用的对象不能发起评估' },
    {
      key: 'contextPath',
      label: '检索上下文路径',
      ok: Boolean(rag.contextPath),
      required: false,
      hint: '未配置时忠实度记“未评估”',
    },
    {
      key: 'citationPath',
      label: '引用来源路径',
      ok: Boolean(rag.citationPath),
      required: false,
      hint: '未配置时引用准确性记“未评估”；建议同时配置引用文档标识字段',
    },
    {
      key: 'testKnowledgeBaseId',
      label: '测试知识库标识',
      ok: Boolean(testKnowledgeBaseId(rag)),
      required: false,
      hint: '请求模板含 {{knowledge_base_id}} 时必须填写',
    },
  ];
  if (mode === 'TEST_PACKAGE') {
    checks.push(
      {
        key: 'upload',
        label: '知识库上传接口（自动导入测试知识库包）',
        ok: Boolean(rag.knowledgeUpload),
        required: false,
        hint: '未配置时需下载测试知识库包手工导入被测系统，并在发起时勾选“已导入”',
      },
      {
        key: 'delete',
        label: '删除接口（运行结束自动清理）',
        ok: Boolean(rag.knowledgeDelete),
        required: false,
        hint: '未配置时平台上传的测试文档不会自动删除，结果页会给出残留清单',
      },
    );
  }
  if (mode === 'RETRIEVAL_API') {
    checks.push({
      key: 'retrieval',
      label: '检索接口',
      ok: Boolean(rag.retrieval),
      required: true,
      hint: '“检索接口直评”模式必须配置，用于计算 Hit@k 与 MRR',
    });
  }
  checks.push({
    key: 'restricted',
    label: '受限库上传凭据（越权检测）',
    ok: Boolean(rag.knowledgeUpload?.restrictedKnowledgeBaseId && hasSecret),
    required: false,
    hint: '未配置时越权读取项显示“未评估：缺少受限库上传凭据”（也可手工导入哨兵文档后勾选）',
  });
  return checks;
}

export async function ragEvalRoutes(app: FastifyInstance, opts: RagEvalRoutesOptions = {}) {
  const chat = opts.chat ?? chatComplete;
  const dispatchRun = opts.dispatchRun ?? enqueueEvalTask;
  const dispatchTestGen = opts.dispatchTestGen ?? enqueueRagTestGen;
  const cancelRun = opts.cancelRun ?? requestEvalTaskCancel;
  void chat;
  app.addHook('preHandler', authenticate);
  const canRead = { preHandler: [requirePermission('rag_eval:read')] };
  // 许可特性沿用 web_ai：RAG 专项评估属于对 Web/AI 应用的评估能力，与评估对象、评估任务同一授权口径。
  const canManage = { preHandler: [requirePermission('rag_eval:manage'), requireLicensedFeature('web_ai')] };
  const canRun = { preHandler: [requirePermission('rag_eval:run'), requireLicensedFeature('web_ai')] };
  // 下载安全测试素材原文（投毒/哨兵文档、测试知识库包）：只看 manage 权限，不额外改变许可口径（原先为只读接口）。
  const canViewSecurity = { preHandler: [requirePermission('rag_eval:manage')] };

  // ---------- 能力状态 ----------
  app.get('/status', canRead, async () => {
    const judge = await resolveRagJudge(prisma as never);
    return {
      judgeConfigured: Boolean(judge),
      judgeModelName: judge?.name ?? null,
      message: judge ? null : RAG_JUDGE_NOT_CONFIGURED_MESSAGE,
      judgeSettingsPath: RAG_JUDGE_SETTINGS_PATH,
      maxDocumentBytes: RAG_DOCUMENT_MAX_BYTES,
      formats: ['txt', 'md', 'pdf', 'docx'],
      alignmentModes: RAG_ALIGNMENT_MODES.map((m) => ({ key: m, label: RAG_ALIGNMENT_LABEL[m] })),
      importFields: RAG_IMPORT_FIELDS,
    };
  });

  app.post('/judge/check', canRead, async (request) => {
    const { modelTargetId } = z.object({ modelTargetId: z.string().uuid().optional() }).parse(request.body ?? {});
    const target = modelTargetId ? await prisma.modelTarget.findUnique({ where: { id: modelTargetId } }) : null;
    if (modelTargetId && !target) throw notFound('评估对象不存在');
    const judge = await resolveRagJudge(prisma as never, target ? { id: target.id, baseUrl: target.baseUrl, model: target.model } : undefined);
    return checkRagJudge(judge, chat);
  });

  app.post('/targets/:id/check', canRead, async (request) => {
    const { id } = idParams.parse(request.params);
    const { mode } = z.object({ mode: alignmentMode.optional() }).parse(request.body ?? {});
    const target = await prisma.modelTarget.findUnique({ where: { id } });
    if (!target) throw notFound('评估对象不存在');
    const rag = readStoredRagOptions(target.ragOptions);
    return checkRagTarget(target, rag, ragConfigChecklist(target, mode ?? rag.defaultAlignmentMode ?? 'KB_EXISTING'));
  });

  // ---------- 知识库 ----------
  app.get('/corpora', canRead, async () => {
    const rows = await prisma.ragCorpus.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { documents: true, chunks: true, testSets: true } } },
    });
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      createdAt: c.createdAt,
      documentCount: c._count.documents,
      chunkCount: c._count.chunks,
      testSetCount: c._count.testSets,
    }));
  });

  app.post('/corpora', canManage, async (request, reply) => {
    const body = corpusBody.parse(request.body);
    const created = await prisma.ragCorpus.create({
      data: { name: body.name, description: body.description, createdById: request.currentUser!.id },
    });
    await writeAudit({
      ...actor(request),
      action: 'rag_eval.corpus.create',
      targetType: 'rag_corpus',
      targetId: created.id,
      detail: { name: created.name },
    });
    reply.code(201);
    return created;
  });

  app.delete('/corpora/:id', canManage, async (request) => {
    const { id } = idParams.parse(request.params);
    await loadCorpus(id);
    const used = await prisma.ragEvalRun.count({ where: { testSet: { corpusId: id } } });
    if (used > 0) throw badRequest('该知识库的测试集已有评估运行记录，不能删除');
    await prisma.ragCorpus.delete({ where: { id } });
    await writeAudit({ ...actor(request), action: 'rag_eval.corpus.delete', targetType: 'rag_corpus', targetId: id });
    return { ok: true };
  });

  app.get('/corpora/:id/documents', canRead, async (request) => {
    const { id } = idParams.parse(request.params);
    await loadCorpus(id);
    return prisma.ragDocument.findMany({ where: { corpusId: id }, orderBy: { createdAt: 'asc' } });
  });

  app.post('/corpora/:id/documents', canManage, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await loadCorpus(id);
    const body = uploadBody.parse(request.body);
    const format = detectFormat(body.filename);
    if (!format) throw badRequest('仅支持 txt、md、pdf、docx 文档');
    const buffer = Buffer.from(body.contentBase64, 'base64');
    if (buffer.length === 0) throw badRequest('上传文件内容为空');
    let text: string;
    try {
      text = await extractDocumentText(buffer, format);
    } catch (err) {
      if (err instanceof RagExtractError) throw badRequest(err.message);
      throw err;
    }
    const chunks = chunkText(text);
    const doc = await prisma.$transaction(async (tx) => {
      const created = await tx.ragDocument.create({
        data: {
          corpusId: id,
          filename: body.filename,
          format,
          sizeBytes: buffer.length,
          sha256: sha256Hex(buffer),
          textLength: text.length,
          chunkCount: chunks.length,
        },
      });
      await tx.ragChunk.createMany({ data: chunks.map((c) => ({ corpusId: id, documentId: created.id, ...c })) });
      return created;
    });
    await writeAudit({
      ...actor(request),
      action: 'rag_eval.document.upload',
      targetType: 'rag_document',
      targetId: doc.id,
      detail: { corpusId: id, filename: doc.filename, format, sizeBytes: doc.sizeBytes, chunkCount: doc.chunkCount },
    });
    reply.code(201);
    return doc;
  });

  app.delete('/documents/:id', canManage, async (request) => {
    const { id } = idParams.parse(request.params);
    const doc = await prisma.ragDocument.findUnique({ where: { id } });
    if (!doc) throw notFound('文档不存在');
    // 文档是知识库的子表（不带 tenantId），按父对象校验租户归属。
    await loadCorpus(doc.corpusId);
    const chunkIds = (await prisma.ragChunk.findMany({ where: { documentId: id }, select: { id: true } })).map(
      (c) => c.id,
    );
    if (chunkIds.length > 0) {
      const referenced = await prisma.ragTestItem.count({
        where: { testSet: { corpusId: doc.corpusId }, sourceChunkIds: { hasSome: chunkIds } },
      });
      if (referenced > 0) throw badRequest('该文档的切块已被测试集题目引用，不能删除');
    }
    await prisma.ragDocument.delete({ where: { id } });
    await writeAudit({
      ...actor(request),
      action: 'rag_eval.document.delete',
      targetType: 'rag_document',
      targetId: id,
      detail: { corpusId: doc.corpusId, filename: doc.filename },
    });
    return { ok: true };
  });

  app.get('/documents/:id/chunks', canRead, async (request) => {
    const { id } = idParams.parse(request.params);
    const doc = await prisma.ragDocument.findUnique({
      where: { id },
      select: { id: true, corpusId: true },
    });
    if (!doc) throw notFound('文档不存在');
    await loadCorpus(doc.corpusId);
    return prisma.ragChunk.findMany({ where: { documentId: id }, orderBy: { seq: 'asc' } });
  });

  /** 知识库全部切块（题目编辑选择来源切块用，只返回摘要）。 */
  app.get('/corpora/:id/chunks', canRead, async (request) => {
    const { id } = idParams.parse(request.params);
    await loadCorpus(id);
    const rows = await prisma.ragChunk.findMany({
      where: { corpusId: id },
      orderBy: [{ documentId: 'asc' }, { seq: 'asc' }],
      take: 2000,
      select: { id: true, seq: true, content: true, document: { select: { filename: true } } },
    });
    return rows.map((c) => ({ id: c.id, seq: c.seq, filename: c.document.filename, preview: c.content.slice(0, 120) }));
  });

  // ---------- 可评估的 RAG 对象（不含任何凭据/接入配置）----------
  app.get('/targets', canRead, async (request) => {
    const q = z.object({ mode: alignmentMode.optional() }).parse(request.query);
    const rows = await prisma.modelTarget.findMany({
      where: { isRag: true, targetType: { notIn: ['JUDGE', 'GATEWAY_LOG'] } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        targetType: true,
        isActive: true,
        isRag: true,
        ragOptions: true,
        ragRestrictedUploadSecret: true,
      },
    });
    return rows.map((t) => {
      const rag = readStoredRagOptions(t.ragOptions);
      const checklist = ragConfigChecklist(t, q.mode ?? rag.defaultAlignmentMode ?? 'KB_EXISTING');
      return {
        id: t.id,
        name: t.name,
        targetType: t.targetType,
        isActive: t.isActive,
        eligible: isRagEligibleType(t.targetType),
        defaultAlignmentMode: rag.defaultAlignmentMode ?? null,
        citationConfigured: Boolean(rag.citationPath),
        contextConfigured: Boolean(rag.contextPath),
        knowledgeUploadConfigured: Boolean(rag.knowledgeUpload),
        knowledgeDeleteConfigured: Boolean(rag.knowledgeDelete),
        retrievalConfigured: Boolean(rag.retrieval),
        restrictedKnowledgeBaseConfigured: Boolean(rag.knowledgeUpload?.restrictedKnowledgeBaseId),
        restrictedCredentialConfigured: checklist.find((c) => c.key === 'restricted')!.ok,
        checklist,
        ready: checklist.every((c) => !c.required || c.ok),
      };
    });
  });

  // ---------- 测试集 ----------
  app.get('/test-sets', canRead, async (request) => {
    const q = z.object({ corpusId: z.string().uuid().optional() }).parse(request.query);
    const rows = await prisma.ragTestSet.findMany({
      where: q.corpusId ? { corpusId: q.corpusId } : {},
      orderBy: { createdAt: 'desc' },
      include: { corpus: { select: { name: true } }, _count: { select: { items: true, runs: true } } },
    });
    return rows.map((s) => ({
      id: s.id,
      corpusId: s.corpusId,
      corpusName: s.corpus.name,
      name: s.name,
      seed: s.seed,
      alignmentMode: s.alignmentMode,
      alignmentModeLabel: RAG_ALIGNMENT_LABEL[s.alignmentMode as RagAlignmentMode] ?? s.alignmentMode,
      generationStatus: s.generationStatus,
      generationProgress: s.generationProgress,
      generationError: s.generationError,
      promptVersion: s.promptVersion,
      judgeModelName: s.judgeModelName,
      generationStats: s.generationStats,
      itemCount: s._count.items,
      runCount: s._count.runs,
      createdAt: s.createdAt,
    }));
  });

  const createSet = async (
    request: FastifyRequest,
    corpusId: string,
    input: {
      name: string;
      seed?: string;
      alignmentMode: RagAlignmentMode;
      includeSecurity: boolean;
      generating: boolean;
      stats: Record<string, unknown>;
    },
  ) => {
    const seed = input.seed ?? randomBytes(6).toString('hex');
    const fx = buildSecurityFixtures(seed);
    return prisma.ragTestSet.create({
      data: {
        corpusId,
        name: input.name,
        seed,
        alignmentMode: input.alignmentMode,
        promptVersion: RAG_TESTGEN_PROMPT_VERSION,
        generationStatus: input.generating ? 'GENERATING' : 'READY',
        generationProgress: input.generating ? json({ planned: 0, done: 0, generated: 0, failed: 0 }) : undefined,
        generationStats: json({ ...input.stats, securityTemplateVersion: RAG_SECURITY_TEMPLATE_VERSION, includeSecurity: input.includeSecurity }),
        poisonDocument: fx.poisonDocument,
        poisonCanary: fx.poisonCanary,
        sentinelDocument: fx.sentinelDocument,
        sentinelToken: fx.sentinelToken,
        createdById: request.currentUser!.id,
        items: {
          create: input.includeSecurity
            ? fx.items.map((i) => ({
                type: i.type,
                question: i.question,
                referenceAnswer: i.referenceAnswer,
                sourceChunkIds: [],
                origin: 'TEMPLATE',
                metadata: json(i.metadata),
              }))
            : [],
        },
      },
    });
  };

  /** 异步生成：立即返回 202 与测试集 ID，worker 执行生成并写进度。 */
  app.post('/corpora/:id/test-sets/generate', canManage, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await loadCorpus(id);
    const body = generateBody.parse(request.body);
    const qualityRequested = RAG_QUALITY_TYPES.reduce((n, t) => n + (body.counts[t] ?? 0), 0);
    if (qualityRequested === 0 && !body.includeSecurity) throw badRequest('请至少选择一类题目');
    if (qualityRequested > 0) {
      const chunkCount = await prisma.ragChunk.count({ where: { corpusId: id } });
      if (chunkCount === 0) throw badRequest('知识库中还没有文档切块，请先在第 2 步上传文档');
      const judge = await resolveRagJudge(prisma as never);
      if (!judge) throw badRequest(RAG_JUDGE_NOT_CONFIGURED_MESSAGE, 'RAG_JUDGE_NOT_CONFIGURED');
    }
    const set = await createSet(request, id, {
      name: body.name,
      seed: body.seed,
      alignmentMode: body.alignmentMode,
      includeSecurity: body.includeSecurity,
      generating: qualityRequested > 0,
      stats: { params: { counts: body.counts, includeSecurity: body.includeSecurity }, requested: body.counts },
    });
    await writeAudit({
      ...actor(request),
      action: 'rag_eval.test_set.generate',
      targetType: 'rag_test_set',
      targetId: set.id,
      detail: { corpusId: id, seed: set.seed, alignmentMode: body.alignmentMode, counts: body.counts, promptVersion: RAG_TESTGEN_PROMPT_VERSION },
    });
    if (qualityRequested > 0) {
      try {
        await dispatchTestGen(set.id);
      } catch (err) {
        await prisma.ragTestSet.update({
          where: { id: set.id },
          data: { generationStatus: 'FAILED', generationError: `生成任务入队失败：${(err as Error).message}` },
        });
        throw badRequest('生成任务入队失败，请检查队列服务（Redis/Valkey）后重试', 'RAG_TESTGEN_ENQUEUE_FAILED');
      }
    }
    reply.code(202);
    return { id: set.id, name: set.name, seed: set.seed, generationStatus: set.generationStatus };
  });

  /** 新建空测试集（手工录入或导入已有问答集）。 */
  app.post('/corpora/:id/test-sets', canManage, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await loadCorpus(id);
    const body = emptySetBody.parse(request.body);
    const set = await createSet(request, id, {
      name: body.name,
      alignmentMode: body.alignmentMode,
      includeSecurity: body.includeSecurity,
      generating: false,
      stats: { manual: true },
    });
    await writeAudit({
      ...actor(request),
      action: 'rag_eval.test_set.create',
      targetType: 'rag_test_set',
      targetId: set.id,
      detail: { corpusId: id, alignmentMode: body.alignmentMode },
    });
    reply.code(201);
    return { id: set.id, name: set.name, seed: set.seed, generationStatus: set.generationStatus };
  });

  app.post('/test-sets/:id/generation/cancel', canManage, async (request) => {
    const { id } = idParams.parse(request.params);
    const set = await loadTestSet(id);
    if (set.generationStatus !== 'GENERATING') throw badRequest('测试集当前不在生成中');
    await prisma.ragTestSet.update({ where: { id }, data: { generationStatus: 'CANCELED' } });
    await writeAudit({ ...actor(request), action: 'rag_eval.test_set.generate_cancel', targetType: 'rag_test_set', targetId: id });
    return { ok: true };
  });

  app.patch('/test-sets/:id', canManage, async (request) => {
    const { id } = idParams.parse(request.params);
    await loadTestSet(id);
    const body = patchSetBody.parse(request.body);
    const updated = await prisma.ragTestSet.update({ where: { id }, data: body });
    await writeAudit({ ...actor(request), action: 'rag_eval.test_set.update', targetType: 'rag_test_set', targetId: id, detail: body });
    return { id: updated.id, name: updated.name, alignmentMode: updated.alignmentMode };
  });

  app.get('/test-sets/:id', canRead, async (request) => {
    const { id } = idParams.parse(request.params);
    const set = await prisma.ragTestSet.findUnique({
      where: { id },
      include: { corpus: { select: { id: true, name: true } }, items: { orderBy: { createdAt: 'asc' } } },
    });
    if (!set) throw notFound('测试集不存在');
    const chunkIds = [...new Set(set.items.flatMap((i) => i.sourceChunkIds))];
    const chunks = await prisma.ragChunk.findMany({
      where: { id: { in: chunkIds } },
      select: { id: true, seq: true, content: true, document: { select: { filename: true } } },
    });
    const { poisonCanary: _p, sentinelToken: _s, poisonDocument: _pd, sentinelDocument: _sd, ...rest } = set;
    const out = {
      ...rest,
      alignmentModeLabel: RAG_ALIGNMENT_LABEL[set.alignmentMode as RagAlignmentMode] ?? set.alignmentMode,
      sources: chunks.map((c) => ({ id: c.id, seq: c.seq, filename: c.document.filename, content: c.content })),
    };
    if (canSeeSecurityMaterial(request)) return out;
    // 只读：剥离 metadata 敏感键（canaries 等），再对整体做一次标记打码兜底（防手工题干/参考答案里写入标记）。
    const markers = testSetMarkers(set, set.items.map((i) => i.metadata));
    return redactMarkers({ ...out, items: out.items.map((i) => ({ ...i, metadata: stripSensitiveMetadata(i.metadata) })) }, markers);
  });

  app.delete('/test-sets/:id', canManage, async (request) => {
    const { id } = idParams.parse(request.params);
    await loadTestSet(id);
    if ((await prisma.ragEvalRun.count({ where: { testSetId: id } })) > 0) {
      throw badRequest('该测试集已有评估运行记录，不能删除');
    }
    await prisma.ragTestSet.delete({ where: { id } });
    await writeAudit({ ...actor(request), action: 'rag_eval.test_set.delete', targetType: 'rag_test_set', targetId: id });
    return { ok: true };
  });

  /** 下载平台生成的安全测试文档（投毒/间接注入、越权哨兵）：含金丝雀原文，仅 manage。 */
  app.get('/test-sets/:id/security-documents/:kind', canViewSecurity, async (request, reply) => {
    const { id, kind } = z.object({ id: z.string().uuid(), kind: z.enum(['poison', 'sentinel']) }).parse(request.params);
    const set = await loadTestSet(id);
    const filename = kind === 'poison' ? POISON_DOCUMENT_FILENAME : SENTINEL_DOCUMENT_FILENAME;
    await writeAudit({
      ...actor(request),
      action: 'rag_eval.security_document.download',
      targetType: 'rag_test_set',
      targetId: id,
      detail: { kind },
    });
    reply.header('content-type', 'text/markdown; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${filename}"`);
    return kind === 'poison' ? set.poisonDocument : set.sentinelDocument;
  });

  /** 测试知识库包（zip：documents/ + restricted/ + manifest.json）：内含投毒与哨兵文档原文，仅 manage。 */
  app.get('/test-sets/:id/package', canViewSecurity, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const set = await loadTestSet(id);
    const docs = await prisma.ragDocument.findMany({
      where: { corpusId: set.corpusId },
      include: { chunks: { orderBy: { seq: 'asc' } } },
    });
    if (docs.length === 0) throw badRequest('知识库中还没有文档，请先在第 2 步上传文档');
    const pkg = buildTestPackage(set, docs, { includeSecurity: true });
    const zip = zipTestPackage(pkg);
    await writeAudit({
      ...actor(request),
      action: 'rag_eval.test_package.download',
      targetType: 'rag_test_set',
      targetId: id,
      detail: { documents: pkg.documents.length, bytes: zip.byteLength },
    });
    reply.header('content-type', 'application/zip');
    reply.header('content-disposition', `attachment; filename="lse-rag-test-package-${set.seed}.zip"`);
    return reply.send(Buffer.from(zip));
  });

  app.post('/test-sets/:id/items', canManage, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const set = await loadTestSet(id);
    assertEditable(set);
    const body = itemBody.parse(request.body);
    await assertChunksInCorpus(set.corpusId, body.sourceChunkIds);
    const item = await prisma.ragTestItem.create({
      data: {
        testSetId: id,
        type: body.type,
        question: body.question,
        referenceAnswer: body.referenceAnswer ?? null,
        sourceChunkIds: body.sourceChunkIds,
        origin: 'MANUAL',
        metadata: securityMetadata(body.type, set),
      },
    });
    await writeAudit({
      ...actor(request),
      action: 'rag_eval.test_item.create',
      targetType: 'rag_test_item',
      targetId: item.id,
      detail: { testSetId: id, type: item.type },
    });
    reply.code(201);
    return item;
  });

  app.patch('/test-sets/:id/items/:itemId', canManage, async (request) => {
    const { id, itemId } = itemParams.parse(request.params);
    const set = await loadTestSet(id);
    assertEditable(set);
    const existing = await prisma.ragTestItem.findFirst({ where: { id: itemId, testSetId: id } });
    if (!existing) throw notFound('题目不存在');
    const body = itemPatch.parse(request.body);
    if (body.sourceChunkIds) await assertChunksInCorpus(set.corpusId, body.sourceChunkIds);
    const nextType = body.type ?? existing.type;
    const updated = await prisma.ragTestItem.update({
      where: { id: itemId },
      data: {
        ...(body.type !== undefined ? { type: body.type, ...(body.type !== existing.type ? { metadata: securityMetadata(nextType, set) } : {}) } : {}),
        ...(body.question !== undefined ? { question: body.question } : {}),
        ...(body.referenceAnswer !== undefined ? { referenceAnswer: body.referenceAnswer } : {}),
        ...(body.sourceChunkIds !== undefined ? { sourceChunkIds: body.sourceChunkIds } : {}),
        origin: existing.origin === 'MANUAL' ? 'MANUAL' : 'EDITED',
      },
    });
    await writeAudit({
      ...actor(request),
      action: 'rag_eval.test_item.update',
      targetType: 'rag_test_item',
      targetId: itemId,
      detail: { testSetId: id },
    });
    return updated;
  });

  app.delete('/test-sets/:id/items/:itemId', canManage, async (request) => {
    const { id, itemId } = itemParams.parse(request.params);
    const set = await loadTestSet(id);
    assertEditable(set);
    const existing = await prisma.ragTestItem.findFirst({ where: { id: itemId, testSetId: id } });
    if (!existing) throw notFound('题目不存在');
    await prisma.ragTestItem.delete({ where: { id: itemId } });
    await writeAudit({
      ...actor(request),
      action: 'rag_eval.test_item.delete',
      targetType: 'rag_test_item',
      targetId: itemId,
      detail: { testSetId: id },
    });
    return { ok: true };
  });

  /**
   * 导入已有问答集（CSV 或 JSONL）。字段：type（FACT/MULTI_HOP/NO_ANSWER/DISTRACTOR/POISON/INDIRECT_INJECTION/CROSS_ACCESS，
   * 也接受中文题型名）、question（必填）、reference_answer、source_chunk_ids（以 ; 分隔的平台切块 ID，可空）。
   * 逐行校验，任何一行出错整体不写入并返回行号与原因；与已有题目近似重复的行跳过。
   */
  app.post('/test-sets/:id/items/import', canManage, async (request) => {
    const { id } = idParams.parse(request.params);
    const set = await loadTestSet(id);
    assertEditable(set);
    const body = importBody.parse(request.body);
    const rows = parseImportRows(body.format, body.content);
    if (rows.length === 0) throw badRequest('导入文件中没有题目');
    if (rows.length > RAG_IMPORT_MAX_ROWS) throw badRequest(`单次最多导入 ${RAG_IMPORT_MAX_ROWS} 题`);
    const errors: Array<{ line: number; error: string }> = [];
    const valid: Array<{ type: string; question: string; referenceAnswer: string | null; sourceChunkIds: string[] }> = [];
    for (const r of rows) {
      const type = normalizeType(r.type);
      if (!type) {
        errors.push({ line: r.line, error: `题型“${r.type ?? ''}”无效` });
        continue;
      }
      const question = (r.question ?? '').trim();
      if (!question) {
        errors.push({ line: r.line, error: '问题不能为空' });
        continue;
      }
      if (question.length > 4000) {
        errors.push({ line: r.line, error: '问题超过 4000 字' });
        continue;
      }
      const ids = (r.sourceChunkIds ?? []).map((s) => s.trim()).filter(Boolean);
      if (ids.some((s) => !z.string().uuid().safeParse(s).success)) {
        errors.push({ line: r.line, error: '来源切块 ID 格式无效' });
        continue;
      }
      valid.push({ type, question, referenceAnswer: (r.referenceAnswer ?? '').trim() || null, sourceChunkIds: ids });
    }
    const allIds = [...new Set(valid.flatMap((v) => v.sourceChunkIds))];
    if (allIds.length) {
      const found = new Set(
        (await prisma.ragChunk.findMany({ where: { id: { in: allIds }, corpusId: set.corpusId }, select: { id: true } })).map((c) => c.id),
      );
      valid.forEach((v, i) => {
        if (v.sourceChunkIds.some((c) => !found.has(c))) errors.push({ line: rows[i]!.line, error: '来源切块不属于该测试集的知识库' });
      });
    }
    if (errors.length) throw badRequest(`导入失败：${errors.slice(0, 5).map((e) => `第 ${e.line} 行 ${e.error}`).join('；')}`, 'RAG_IMPORT_INVALID');
    const existing = (await prisma.ragTestItem.findMany({ where: { testSetId: id }, select: { question: true } })).map((e) => e.question);
    const accepted: typeof valid = [];
    let duplicates = 0;
    for (const v of valid) {
      if (isNearDuplicate(v.question, existing)) {
        duplicates++;
        continue;
      }
      existing.push(v.question);
      accepted.push(v);
    }
    await prisma.ragTestItem.createMany({
      data: accepted.map((v) => ({
        testSetId: id,
        type: v.type,
        question: v.question,
        referenceAnswer: v.referenceAnswer,
        sourceChunkIds: v.sourceChunkIds,
        origin: 'IMPORTED',
        metadata: securityMetadata(v.type, set) as Prisma.InputJsonValue,
      })),
    });
    await writeAudit({
      ...actor(request),
      action: 'rag_eval.test_item.import',
      targetType: 'rag_test_set',
      targetId: id,
      detail: { format: body.format, imported: accepted.length, duplicates },
    });
    return { imported: accepted.length, duplicates };
  });

  app.get('/test-sets/:id/items/export', canRead, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const q = z.object({ format: z.enum(['csv', 'jsonl']).default('csv') }).parse(request.query);
    const set = await loadTestSet(id);
    const items = await prisma.ragTestItem.findMany({ where: { testSetId: id }, orderBy: { createdAt: 'asc' } });
    await writeAudit({
      ...actor(request),
      action: 'rag_eval.test_item.export',
      targetType: 'rag_test_set',
      targetId: id,
      detail: { format: q.format, count: items.length },
    });
    const rows = items.map((i) => ({
      type: i.type,
      question: i.question,
      reference_answer: i.referenceAnswer ?? '',
      source_chunk_ids: i.sourceChunkIds.join(';'),
    }));
    if (!canSeeSecurityMaterial(request)) {
      const markers = testSetMarkers(set, items.map((i) => i.metadata));
      rows.splice(0, rows.length, ...redactMarkers(rows, markers));
    }
    const base = `rag-test-set-${set.seed}`;
    if (q.format === 'jsonl') {
      reply.header('content-type', 'application/x-ndjson; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="${base}.jsonl"`);
      return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
    }
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${base}.csv"`);
    return '\ufeff' + [RAG_IMPORT_FIELDS.join(','), ...rows.map((r) => RAG_IMPORT_FIELDS.map((f) => csvCell(r[f])).join(','))].join('\r\n') + '\r\n';
  });

  // ---------- 评估运行 ----------
  app.post('/runs', canRun, async (request, reply) => {
    const body = runBody.parse(request.body);
    const set = await prisma.ragTestSet.findUnique({
      where: { id: body.testSetId },
      include: { _count: { select: { items: true } } },
    });
    if (!set) throw notFound('测试集不存在');
    if (set.generationStatus === 'GENERATING') throw badRequest('测试集还在生成中，请等待生成完成');
    if (set._count.items === 0) throw badRequest('测试集没有题目，请在第 3 步生成、导入或手工新增题目');
    const target = await prisma.modelTarget.findUnique({ where: { id: body.modelTargetId } });
    if (!target) throw notFound('评估对象不存在');
    assertNonEndpointTaskTarget(target);
    if (!target.isRag)
      throw badRequest('该评估对象未声明为 RAG 应用，请先在评估对象中开启“声明为 RAG 应用”', 'RAG_TARGET_REQUIRED');
    if (!target.isActive) throw badRequest('评估对象已停用');
    if (!isRagEligibleType(target.targetType)) {
      throw badRequest('RAG 专项评估仅支持智能体应用 API（自定义 HTTP）类评估对象', 'RAG_TARGET_TYPE_UNSUPPORTED');
    }
    const mode = set.alignmentMode as RagAlignmentMode;
    const rag = readStoredRagOptions(target.ragOptions);
    if (mode === 'RETRIEVAL_API' && !rag.retrieval)
      throw badRequest('“检索接口直评”模式需要在评估对象中配置检索接口', 'RAG_RETRIEVAL_REQUIRED');
    const hasQuality = await prisma.ragTestItem.count({ where: { testSetId: set.id, type: { in: [...RAG_QUALITY_TYPES] } } });
    if (hasQuality > 0) {
      const judge = await resolveRagJudge(prisma as never, { id: target.id, baseUrl: target.baseUrl, model: target.model });
      if (!judge) throw badRequest(RAG_JUDGE_NOT_CONFIGURED_MESSAGE, 'RAG_JUDGE_NOT_CONFIGURED');
    }
    const confirmed = mode !== 'TEST_PACKAGE' && body.alignmentConfirmed;
    const now = new Date();
    const { task, run } = await prisma.$transaction(async (tx) => {
      const task = await tx.evalTask.create({
        data: {
          name: body.name ?? `RAG 专项评估 · ${set.name}`,
          description: `RAG 专项评估：测试集 ${set.name}（种子 ${set.seed}，知识对齐模式：${RAG_ALIGNMENT_LABEL[mode]}）`,
          status: 'PENDING',
          modelTargetId: target.id,
          engines: [RAG_EVAL_ENGINE],
          dimensions: ['rag_quality', 'rag_security'],
          totalQuestions: set._count.items,
          createdById: request.currentUser!.id,
        },
      });
      const run = await tx.ragEvalRun.create({
        data: {
          taskId: task.id,
          testSetId: set.id,
          modelTargetId: target.id,
          alignmentMode: mode,
          alignmentConfirmedById: confirmed ? request.currentUser!.id : null,
          alignmentConfirmedByName: confirmed ? request.currentUser!.username : null,
          alignmentConfirmedAt: confirmed ? now : null,
          packageImported: mode === 'TEST_PACKAGE' && body.packageImported,
          poisonDocumentImported: body.poisonDocumentImported,
          sentinelDocumentImported: body.sentinelDocumentImported,
          createdById: request.currentUser!.id,
        },
      });
      return { task, run };
    });
    await writeAudit({
      ...actor(request),
      action: 'rag_eval.run.create',
      targetType: 'rag_eval_run',
      targetId: run.id,
      detail: {
        taskId: task.id,
        testSetId: set.id,
        modelTargetId: target.id,
        alignmentMode: mode,
        packageImported: run.packageImported,
        poisonDocumentImported: body.poisonDocumentImported,
        sentinelDocumentImported: body.sentinelDocumentImported,
      },
    });
    if (confirmed) {
      await writeAudit({
        ...actor(request),
        action: 'rag_eval.run.alignment_confirm',
        targetType: 'rag_eval_run',
        targetId: run.id,
        detail: {
          alignmentMode: mode,
          statement: '确认：这些文档已在被测系统知识库中并完成索引',
          confirmedAt: now.toISOString(),
        },
      });
    }
    await dispatchRun(task.id);
    reply.code(201);
    return { id: run.id, taskId: task.id, status: run.status };
  });

  app.post('/runs/:id/cancel', canRun, async (request) => {
    const { id } = idParams.parse(request.params);
    // 停止逻辑在 cancel.ts，和检测任务的「停止」共用。
    await cancelRagEvalRun(request.currentUser!, id, cancelRun);
    return { ok: true };
  });

  const runInclude = {
    testSet: { select: { name: true } },
    modelTarget: { select: { name: true, ragOptions: true } },
    task: { select: { status: true, progress: true, processedQuestions: true, totalQuestions: true } },
  } satisfies Prisma.RagEvalRunInclude;

  app.get('/runs', canRead, async (request) => {
    const q = z.object({ testSetId: z.string().uuid().optional() }).parse(request.query);
    const runs = await prisma.ragEvalRun.findMany({
      where: q.testSetId ? { testSetId: q.testSetId } : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: runInclude,
    });
    if (canSeeSecurityMaterial(request)) return runs.map(serializeRun);
    const markerCache = new Map<string, string[]>();
    const out = [];
    for (const r of runs) {
      if (!markerCache.has(r.testSetId)) markerCache.set(r.testSetId, await markersForTestSet(r.testSetId));
      out.push(redactMarkers(serializeRun(r), markerCache.get(r.testSetId)!));
    }
    return out;
  });

  app.get('/runs/:id', canRead, async (request) => {
    const { id } = idParams.parse(request.params);
    const run = await prisma.ragEvalRun.findUnique({ where: { id }, include: runInclude });
    if (!run) throw notFound('评估运行不存在');
    const rag = readStoredRagOptions(run.modelTarget.ragOptions);
    const rows = await prisma.ragEvalResult.findMany({
      where: { runId: id },
      select: {
        itemType: true,
        status: true,
        verdict: true,
        correctness: true,
        faithfulness: true,
        refusalOk: true,
        citationAccuracy: true,
        retrievalRank: true,
        retrievalEvaluated: true,
        needsReview: true,
        notEvaluated: true,
        reason: true,
        errorMessage: true,
      },
    });
    const out = {
      ...serializeRun(run),
      metrics: computeRagTypeMetrics(rows),
      groups: computeRagGroupMetrics(rows),
      capabilities: {
        citationConfigured: Boolean(rag.citationPath),
        contextConfigured: Boolean(rag.contextPath),
        knowledgeUploadConfigured: Boolean(rag.knowledgeUpload),
        knowledgeDeleteConfigured: Boolean(rag.knowledgeDelete),
        retrievalConfigured: Boolean(rag.retrieval),
        restrictedKnowledgeBaseConfigured: Boolean(rag.knowledgeUpload?.restrictedKnowledgeBaseId),
      },
    };
    return canSeeSecurityMaterial(request) ? out : redactMarkers(out, await markersForTestSet(run.testSetId));
  });

  app.get('/runs/:id/results', canRead, async (request) => {
    const { id } = idParams.parse(request.params);
    const q = resultsQuery.parse(request.query);
    const run = await prisma.ragEvalRun.findUnique({ where: { id }, select: { id: true, testSetId: true } });
    if (!run) throw notFound('评估运行不存在');
    const where: Prisma.RagEvalResultWhereInput = {
      runId: id,
      ...(q.verdict ? { verdict: q.verdict } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.itemType ? { itemType: q.itemType } : {}),
      ...(q.needsReview ? { needsReview: q.needsReview === 'true' } : {}),
    };
    const [total, items] = await Promise.all([
      prisma.ragEvalResult.count({ where }),
      prisma.ragEvalResult.findMany({ where, orderBy: { createdAt: 'asc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    const page = { total, page: q.page, pageSize: q.pageSize, items };
    // 只读：回复、原因、检索上下文、引用中可能带出金丝雀/哨兵原文（证据），统一打码；判定字段不变。
    return canSeeSecurityMaterial(request) ? page : redactMarkers(page, await markersForTestSet(run.testSetId));
  });
}

function serializeRun(run: {
  id: string;
  taskId: string;
  testSetId: string;
  modelTargetId: string;
  status: string;
  summary: Prisma.JsonValue;
  error: string | null;
  alignmentMode: string;
  alignmentConfirmedByName: string | null;
  alignmentConfirmedAt: Date | null;
  packageImported: boolean;
  indexProbe: Prisma.JsonValue;
  uploads: Prisma.JsonValue;
  cleanup: Prisma.JsonValue;
  poisonDocumentImported: boolean;
  sentinelDocumentImported: boolean;
  createdAt: Date;
  testSet: { name: string };
  modelTarget: { name: string };
  task: { status: string; progress: number; processedQuestions: number; totalQuestions: number };
}) {
  return {
    id: run.id,
    taskId: run.taskId,
    testSetId: run.testSetId,
    testSetName: run.testSet.name,
    modelTargetId: run.modelTargetId,
    modelTargetName: run.modelTarget.name,
    status: run.status,
    taskStatus: run.task.status,
    progress: run.task.progress,
    processed: run.task.processedQuestions,
    total: run.task.totalQuestions,
    summary: run.summary,
    error: run.error,
    alignmentMode: run.alignmentMode,
    alignmentModeLabel: RAG_ALIGNMENT_LABEL[run.alignmentMode as RagAlignmentMode] ?? run.alignmentMode,
    alignmentConfirmedByName: run.alignmentConfirmedByName,
    alignmentConfirmedAt: run.alignmentConfirmedAt,
    packageImported: run.packageImported,
    indexProbe: run.indexProbe,
    uploads: run.uploads,
    cleanup: run.cleanup,
    poisonDocumentImported: run.poisonDocumentImported,
    sentinelDocumentImported: run.sentinelDocumentImported,
    createdAt: run.createdAt,
  };
}

/** 手工新增/改型/导入的安全题：按测试集种子重建金丝雀，保证判定依据与测试文档一致。 */
function securityMetadata(type: string, set: { seed: string }): Prisma.InputJsonValue | typeof Prisma.DbNull {
  const fx = buildSecurityFixtures(set.seed);
  if (type === 'POISON') return { canaries: [fx.poisonCanary], requires: 'poison_document' };
  if (type === 'INDIRECT_INJECTION') return { canaries: [fx.injectionCanary, fx.canaryUrl], requires: 'poison_document' };
  if (type === 'CROSS_ACCESS') return { canaries: [fx.sentinelToken], requires: 'sentinel_document' };
  return Prisma.DbNull;
}

const TYPE_ALIASES: Record<string, string> = {
  事实题: 'FACT',
  多跳题: 'MULTI_HOP',
  无答案题: 'NO_ANSWER',
  干扰题: 'DISTRACTOR',
  文档投毒: 'POISON',
  间接提示词注入: 'INDIRECT_INJECTION',
  越权读取其他文档: 'CROSS_ACCESS',
};

function normalizeType(v: string | undefined): string | null {
  const s = (v ?? '').trim();
  if (!s) return null;
  const upper = s.toUpperCase();
  if ((RAG_ITEM_TYPES as readonly string[]).includes(upper)) return upper;
  return TYPE_ALIASES[s] ?? null;
}

interface ImportRow {
  line: number;
  type?: string;
  question?: string;
  referenceAnswer?: string;
  sourceChunkIds?: string[];
}

function splitIds(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') return v.split(/[;,\s]+/).filter(Boolean);
  return [];
}

export function parseImportRows(format: 'csv' | 'jsonl', content: string): ImportRow[] {
  const text = content.replace(/^\ufeff/, '');
  if (format === 'jsonl') {
    const out: ImportRow[] = [];
    text.split(/\r?\n/).forEach((raw, i) => {
      const line = raw.trim();
      if (!line) return;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        throw badRequest(`导入失败：第 ${i + 1} 行不是合法 JSON`, 'RAG_IMPORT_INVALID');
      }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj))
        throw badRequest(`导入失败：第 ${i + 1} 行应为 JSON 对象`, 'RAG_IMPORT_INVALID');
      const r = obj as Record<string, unknown>;
      out.push({
        line: i + 1,
        type: typeof r.type === 'string' ? r.type : undefined,
        question: typeof r.question === 'string' ? r.question : undefined,
        referenceAnswer: typeof r.reference_answer === 'string' ? r.reference_answer : undefined,
        sourceChunkIds: splitIds(r.source_chunk_ids),
      });
    });
    return out;
  }
  let records: Record<string, string>[];
  try {
    records = parseCsv(text, { columns: (h: string[]) => h.map((x) => x.trim().toLowerCase()), skip_empty_lines: true, trim: false, relax_column_count: true });
  } catch (err) {
    throw badRequest(`导入失败：CSV 解析错误（${(err as Error).message.slice(0, 120)}）`, 'RAG_IMPORT_INVALID');
  }
  if (records.length > 0 && !('question' in records[0]!))
    throw badRequest(`导入失败：CSV 表头需包含 ${RAG_IMPORT_FIELDS.join(',')}`, 'RAG_IMPORT_INVALID');
  // 导出给公式触发字符开头的单元格加了 `'`，导回时去掉，保证往返一致。
  const cell = (v: string | undefined) => (v === undefined ? v : restoreFormula(v));
  return records.map((r, i) => ({
    line: i + 2,
    type: cell(r.type),
    question: cell(r.question),
    referenceAnswer: cell(r.reference_answer),
    sourceChunkIds: splitIds(cell(r.source_chunk_ids)),
  }));
}

/** 供 worker 使用的执行入口。 */
export { runRagEvaluation, runRagTestSetGeneration };
