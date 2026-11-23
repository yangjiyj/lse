import type { Prisma, PrismaClient } from '@prisma/client';
import type { LlmCallResult, Severity } from '@lse/shared';
import { prisma } from '../../db.js';
import { chatComplete } from '../../lib/llm-client.js';
import { isEvalTaskCancelRequested } from '../../lib/queue.js';
import { withTenant } from '../../lib/tenant-context.js';
import { writeAudit } from '../../lib/audit.js';
import { decryptCredential } from '../../lib/credential-crypto.js';
import type { EvaluationTargetConfig } from '../eval-targets/invoker.js';
import {
  resolveRagJudge,
  RAG_JUDGE_NOT_CONFIGURED_MESSAGE,
  type RagChatCaller,
} from './judge-model.js';
import { RAG_QUALITY_TYPES, type RagItemType, type RagQualityType } from './generator.js';
import {
  RAG_JUDGE_PROMPT_VERSION,
  RAG_NOT_EVALUATED,
  extractCitations,
  judgeQuality,
  qualityVerdict,
  retrievalRank,
  scoreCitations,
  type SourceDocRef,
} from './rag-judge.js';
import { evaluateSecurityAnswer } from './security.js';
import { redactMarkers, testSetMarkers } from './redact.js';
import {
  readStoredRagOptions,
  testKnowledgeBaseId,
  type RagAlignmentMode,
  type RagOptions,
} from './options.js';
import {
  askRagTarget,
  deleteKnowledgeDocument,
  extractContext,
  retrieveFromTarget,
  uploadKnowledgeDocument,
  type UploadAuth,
} from './target-client.js';
import { buildTestPackage, type PackageDocument } from './test-package.js';
import { docFingerprint, waitForIndexReady, type IndexProbeResult, type ProbeDoc } from './index-probe.js';
import { computeRagGroupMetrics } from './metrics.js';

export const RAG_EVAL_ENGINE = 'rag-eval';

export const RAG_ALIGNMENT_LABEL: Record<RagAlignmentMode, string> = {
  KB_EXISTING: '被测系统已有知识库',
  TEST_PACKAGE: '平台测试知识库包',
  RETRIEVAL_API: '检索接口直评',
};

export const RAG_RESTRICTED_NO_UPLOAD =
  '未评估：投毒测试文档未进入被测知识库（未配置上传接口，也未声明已人工导入）';
export const RAG_RESTRICTED_NO_SENTINEL_CREDENTIAL =
  '未评估：缺少受限库上传凭据（越权哨兵文档不能用被测身份上传）';
export const RAG_RESTRICTED_NO_SENTINEL =
  '未评估：越权哨兵文档未导入测试身份无权访问的受限知识库（未配置受限库自动上传，也未声明已人工导入）';
export const RAG_RESTRICTED_INDEX_NOT_READY = '未评估：投毒文档索引就绪探测未通过';

export interface RunRagEvaluationDeps {
  prisma?: PrismaClient;
  chat?: RagChatCaller;
  askTarget?: typeof askRagTarget;
  upload?: typeof uploadKnowledgeDocument;
  remove?: typeof deleteKnowledgeDocument;
  retrieve?: typeof retrieveFromTarget;
  isCancelRequested?: (taskId: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
}

const QUALITY = new Set<string>(RAG_QUALITY_TYPES);

const FINDING_PROFILE: Record<RagItemType, { riskCategory: string; severity: Severity; title: string }> = {
  FACT: { riskCategory: 'misinformation_hallucination', severity: 'MEDIUM', title: 'RAG 事实题回答错误或超出检索上下文' },
  MULTI_HOP: { riskCategory: 'misinformation_hallucination', severity: 'MEDIUM', title: 'RAG 多跳题回答错误或超出检索上下文' },
  NO_ANSWER: { riskCategory: 'misinformation_hallucination', severity: 'MEDIUM', title: 'RAG 无答案题未拒答（编造答案）' },
  DISTRACTOR: { riskCategory: 'misinformation_hallucination', severity: 'MEDIUM', title: 'RAG 干扰题被错误前提误导' },
  POISON: { riskCategory: 'rag_data_poisoning', severity: 'HIGH', title: 'RAG 文档投毒指令被执行' },
  INDIRECT_INJECTION: { riskCategory: 'prompt_injection', severity: 'HIGH', title: 'RAG 检索内容间接提示词注入生效' },
  CROSS_ACCESS: { riskCategory: 'data_exfiltration', severity: 'CRITICAL', title: 'RAG 越权读取其他租户/受限文档' },
};

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

interface UploadRecord {
  manifestId: string;
  filename: string;
  role: string;
  knowledgeBase: 'test' | 'restricted';
  knowledgeBaseId: string;
  ok: boolean;
  error: string | null;
  documentId: string | null;
}

interface CleanupRecord {
  attempted: boolean;
  ok: boolean;
  reason: string | null;
  residual: Array<{ filename: string; knowledgeBaseId: string; documentId: string | null; error: string | null }>;
  deleted: number;
}

/** 运行前置条件：质量题/检索题/安全题各自能否给出结论，不能则写明原因。 */
interface Readiness {
  mode: RagAlignmentMode;
  quality: { ok: boolean; reason: string | null };
  retrieval: { ok: boolean; reason: string | null };
  poison: { ok: boolean; reason: string | null; mode: 'auto' | 'manual' | 'none' };
  sentinel: { ok: boolean; reason: string | null; mode: 'auto' | 'manual' | 'none' };
  probe: IndexProbeResult | null;
  uploads: UploadRecord[];
}

/**
 * RAG 专项评估执行器（worker 按 RagEvalRun 分发到此）。
 * 流程：解析知识对齐模式 → 模式 B 自动上传测试知识库包 → 索引就绪探测 → 逐题提问/检索与判定 → 清理上传文档。
 * 指标只在知识对齐成立时给出结论，否则逐题记录“未评估（原因）”。
 */
export async function runRagEvaluation(taskId: string, deps: RunRagEvaluationDeps = {}): Promise<void> {
  const db = deps.prisma ?? prisma;
  const chat = deps.chat ?? chatComplete;
  const ask = deps.askTarget ?? askRagTarget;
  const upload = deps.upload ?? uploadKnowledgeDocument;
  const remove = deps.remove ?? deleteKnowledgeDocument;
  const retrieve = deps.retrieve ?? retrieveFromTarget;
  const isCancel = deps.isCancelRequested ?? isEvalTaskCancelRequested;

  const run = await db.ragEvalRun.findUnique({
    where: { taskId },
    include: {
      task: true,
      modelTarget: true,
      testSet: { include: { items: { orderBy: { createdAt: 'asc' } } } },
    },
  });
  if (!run) return;
  if (run.task.status === 'RUNNING' || run.task.status === 'CANCELED') return;

  const log = (level: string, message: string, context?: unknown) =>
    db.evalTaskLog
      .create({ data: { taskId, level, message, context: (context ?? undefined) as Prisma.InputJsonValue } })
      .catch(() => undefined);

  const fail = async (message: string) => {
    await db.ragEvalRun.update({ where: { id: run.id }, data: { status: 'FAILED', error: message } });
    await db.evalTask.update({ where: { id: taskId }, data: { status: 'FAILED', finishedAt: new Date() } });
    await log('error', message);
  };

  const target = run.modelTarget;
  const taskTenantId = run.task.tenantId;
  const mode = (run.alignmentMode as RagAlignmentMode) ?? 'KB_EXISTING';
  const items = run.testSet.items;
  // Finding 走评估任务 findings/报告接口（eval_task:read 即可见），落库前对测试标记打码；
  // 命中类别另存 detail.markerHits，原文仍只在 rag_eval:manage 可见的结果钻取中保留。
  const findingMarkers = testSetMarkers(run.testSet, items.map((i) => i.metadata));
  const hasQuality = items.some((i) => QUALITY.has(i.type));
  // 同 eval-tasks：worker 里没有租户上下文，按任务租户取裁判模型（本租户 + 平台共享）。
  const judge = await withTenant(taskTenantId, () =>
    resolveRagJudge(db as never, { id: target.id, baseUrl: target.baseUrl, model: target.model }),
  );
  if (!judge && hasQuality) {
    await fail(RAG_JUDGE_NOT_CONFIGURED_MESSAGE);
    return;
  }

  await db.ragEvalResult.deleteMany({ where: { runId: run.id } });
  await db.finding.deleteMany({ where: { taskId, engine: RAG_EVAL_ENGINE } });
  await db.evalTask.update({
    where: { id: taskId },
    data: {
      status: 'RUNNING',
      startedAt: new Date(),
      finishedAt: null,
      totalQuestions: items.length,
      processedQuestions: 0,
      passedCount: 0,
      failedCount: 0,
      errorCount: 0,
      progress: 0,
    },
  });
  await db.ragEvalRun.update({ where: { id: run.id }, data: { status: 'RUNNING', error: null } });
  await log('info', `RAG 专项评估开始：${items.length} 题，知识对齐模式「${RAG_ALIGNMENT_LABEL[mode]}」`);

  const abort = new AbortController();
  const rag = readStoredRagOptions(target.ragOptions);
  const kbId = testKnowledgeBaseId(rag);
  const targetCfg: EvaluationTargetConfig = {
    targetType: target.targetType,
    baseUrl: target.baseUrl,
    apiKey: target.apiKey,
    model: target.model,
    extraHeaders: target.extraHeaders,
    defaultParams: target.defaultParams,
    accessConfig: target.accessConfig,
  };

  // ---------- 平台文档与测试知识库包（用于来源映射、探针、自动上传） ----------
  const docs = await db.ragDocument.findMany({
    where: { corpusId: run.testSet.corpusId },
    include: { chunks: { orderBy: { seq: 'asc' } } },
  });
  const pkg = buildTestPackage(run.testSet, docs, { includeSecurity: true });
  const pkgByDocId = new Map(pkg.documents.filter((d) => d.sourceDocumentId).map((d) => [d.sourceDocumentId!, d]));
  const chunkDoc = new Map<string, { documentId: string; content: string }>();
  for (const d of docs) for (const c of d.chunks) chunkDoc.set(c.id, { documentId: d.id, content: c.content });
  const docRefs = new Map<string, SourceDocRef>();
  for (const d of docs) {
    const p = pkgByDocId.get(d.id);
    docRefs.set(d.id, {
      documentId: d.id,
      keys: [d.id, d.filename, d.sha256, ...(p ? [p.manifestId, p.filename, p.sha256] : [])],
      chunkTexts: d.chunks.map((c) => c.content),
    });
  }

  const needPoison = items.some((i) => i.type === 'POISON' || i.type === 'INDIRECT_INJECTION');
  const needSentinel = items.some((i) => i.type === 'CROSS_ACCESS');
  const readiness: Readiness = {
    mode,
    quality: { ok: false, reason: null },
    retrieval: { ok: false, reason: null },
    poison: { ok: false, reason: RAG_RESTRICTED_NO_UPLOAD, mode: 'none' },
    sentinel: { ok: false, reason: RAG_RESTRICTED_NO_SENTINEL, mode: 'none' },
    probe: null,
    uploads: [],
  };

  // ---------- 知识对齐 ----------
  const probeDocs: ProbeDoc[] = [];
  const toProbe = (d: PackageDocument): ProbeDoc => ({
    manifestId: d.manifestId,
    filename: d.filename,
    probe: d.probe,
    fingerprint: docFingerprint(d.content),
  });
  const uploadDoc = async (d: PackageDocument, auth: UploadAuth, kb: string) => {
    const res = await upload(
      targetCfg,
      rag.knowledgeUpload!,
      { filename: d.filename, content: d.content, knowledgeBaseId: kb },
      { signal: abort.signal, auth },
    );
    const rec: UploadRecord = {
      manifestId: d.manifestId,
      filename: d.filename,
      role: d.role,
      knowledgeBase: d.knowledgeBase,
      knowledgeBaseId: kb,
      ok: res.ok,
      error: res.error,
      documentId: res.documentId ?? null,
    };
    readiness.uploads.push(rec);
    return rec;
  };

  const corpusPkgDocs = pkg.documents.filter((d) => d.role === 'corpus');
  const poisonDoc = pkg.documents.find((d) => d.role === 'poison')!;
  const sentinelDoc = pkg.documents.find((d) => d.role === 'sentinel')!;

  if (mode === 'KB_EXISTING') {
    if (run.alignmentConfirmedAt) readiness.quality = { ok: true, reason: null };
    else readiness.quality = { ok: false, reason: RAG_NOT_EVALUATED.alignmentUnconfirmed };
  } else if (mode === 'RETRIEVAL_API') {
    readiness.quality = run.alignmentConfirmedAt
      ? { ok: true, reason: null }
      : { ok: false, reason: RAG_NOT_EVALUATED.alignmentUnconfirmed };
    readiness.retrieval = rag.retrieval
      ? { ok: true, reason: null }
      : { ok: false, reason: RAG_NOT_EVALUATED.retrievalNotConfigured };
  } else {
    // 模式 B：自动上传（配置了上传接口）或用户声明已手工导入，然后做索引就绪探测。
    if (rag.knowledgeUpload && !run.packageImported) {
      for (const d of corpusPkgDocs) {
        await uploadDoc(d, { kind: 'target' }, kbId);
      }
      const failed = readiness.uploads.filter((u) => !u.ok);
      if (failed.length > 0)
        readiness.quality = {
          ok: false,
          reason: `未评估：测试知识库包自动上传失败（${failed[0]!.error ?? '未知原因'}）`,
        };
      probeDocs.push(...corpusPkgDocs.map(toProbe));
    } else if (run.packageImported) {
      probeDocs.push(...corpusPkgDocs.map(toProbe));
    } else {
      readiness.quality = { ok: false, reason: RAG_NOT_EVALUATED.packageNotImported };
    }
  }

  // 投毒文档：已声明人工导入，或配置了上传接口时自动上传到测试知识库。
  if (needPoison) {
    if (run.poisonDocumentImported) {
      readiness.poison = { ok: true, reason: null, mode: 'manual' };
    } else if (rag.knowledgeUpload) {
      const rec = await uploadDoc(poisonDoc, { kind: 'target' }, kbId);
      readiness.poison = rec.ok
        ? { ok: true, reason: null, mode: 'auto' }
        : { ok: false, reason: `未评估：投毒测试文档自动上传失败（${rec.error ?? '未知原因'}）`, mode: 'auto' };
    }
    if (readiness.poison.ok && poisonDoc.probe) probeDocs.push(toProbe(poisonDoc));
  }

  // 越权哨兵：只能用单独的受限库上传凭据上传；被测身份按设计无权访问受限库，因此不做探测。
  if (needSentinel) {
    const restrictedKb = rag.knowledgeUpload?.restrictedKnowledgeBaseId;
    const secret = decryptCredential(target.ragRestrictedUploadSecret);
    if (run.sentinelDocumentImported) {
      readiness.sentinel = { ok: true, reason: null, mode: 'manual' };
    } else if (rag.knowledgeUpload && restrictedKb) {
      if (!secret) {
        readiness.sentinel = { ok: false, reason: RAG_RESTRICTED_NO_SENTINEL_CREDENTIAL, mode: 'none' };
      } else {
        const rec = await uploadDoc(
          sentinelDoc,
          { kind: 'restricted', headerName: rag.restrictedUploadAuthHeader ?? 'Authorization', value: secret },
          restrictedKb,
        );
        readiness.sentinel = rec.ok
          ? { ok: true, reason: null, mode: 'auto' }
          : { ok: false, reason: `未评估：越权哨兵文档上传失败（${rec.error ?? '未知原因'}）`, mode: 'auto' };
      }
    }
  }

  const persistPrep = () =>
    db.ragEvalRun.update({
      where: { id: run.id },
      data: {
        uploads: readiness.uploads as unknown as Prisma.InputJsonValue,
        indexProbe: (readiness.probe ?? undefined) as unknown as Prisma.InputJsonValue,
      },
    });

  // 索引就绪探测（上传或手工导入后，对测试身份可访问的文档）。
  if (probeDocs.length > 0) {
    await log('info', `索引就绪探测开始：${probeDocs.length} 个文档`);
    readiness.probe = await waitForIndexReady(targetCfg, rag, probeDocs, {
      ask,
      retrieve,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      isCanceled: () => isCancel(taskId),
    });
    const hitIds = new Set(readiness.probe.docs.filter((d) => d.hit).map((d) => d.manifestId));
    const corpusProbe = readiness.probe.docs.filter((d) => d.manifestId !== poisonDoc.manifestId);
    const corpusRate = corpusProbe.length ? corpusProbe.filter((d) => d.hit).length / corpusProbe.length : 1;
    if (mode === 'TEST_PACKAGE' && readiness.quality.reason === null) {
      readiness.quality =
        corpusRate >= readiness.probe.threshold
          ? { ok: true, reason: null }
          : {
              ok: false,
              reason: `${RAG_NOT_EVALUATED.indexNotReady}（命中率 ${(corpusRate * 100).toFixed(0)}%，阈值 ${(readiness.probe.threshold * 100).toFixed(0)}%）`,
            };
    }
    if (readiness.poison.ok && poisonDoc.probe && !hitIds.has(poisonDoc.manifestId))
      readiness.poison = { ok: false, reason: RAG_RESTRICTED_INDEX_NOT_READY, mode: readiness.poison.mode };
    await log('info', '索引就绪探测结束', {
      ready: readiness.probe.ready,
      hitRate: readiness.probe.hitRate,
      attempts: readiness.probe.attempts,
    });
  }
  await persistPrep();
  await log('info', '运行前置条件', {
    mode,
    quality: readiness.quality,
    retrieval: readiness.retrieval,
    poison: readiness.poison,
    sentinel: readiness.sentinel,
  });

  // ---------- 逐题执行 ----------
  const counters = { processed: 0, passed: 0, failed: 0, error: 0, restricted: 0, needsReview: 0 };
  let canceled = false;

  const sourceDocsFor = (chunkIds: string[]): SourceDocRef[] => {
    const ids = new Set(chunkIds.map((c) => chunkDoc.get(c)?.documentId).filter((x): x is string => !!x));
    return [...ids].map((id) => docRefs.get(id)!).filter(Boolean);
  };

  const processOne = async (item: (typeof items)[number]) => {
    if (canceled) return;
    if (await isCancel(taskId)) {
      canceled = true;
      abort.abort();
      return;
    }
    const type = item.type as RagItemType;
    const base = {
      runId: run.id,
      itemId: item.id,
      itemType: type,
      question: item.question,
      referenceAnswer: item.referenceAnswer,
    };
    const meta = (item.metadata ?? {}) as Record<string, unknown>;
    const requires = asString(meta.requires);
    const restrictedFor = (reason: string, key: string) =>
      db.ragEvalResult.create({
        data: {
          ...base,
          status: 'RESTRICTED',
          verdict: 'UNKNOWN',
          reason,
          notEvaluated: { [key]: reason } as Prisma.InputJsonValue,
        },
      });

    if (requires === 'poison_document' && !readiness.poison.ok) {
      await restrictedFor(readiness.poison.reason ?? RAG_RESTRICTED_NO_UPLOAD, 'security');
      counters.restricted++;
      counters.processed++;
      return;
    }
    if (requires === 'sentinel_document' && !readiness.sentinel.ok) {
      await restrictedFor(readiness.sentinel.reason ?? RAG_RESTRICTED_NO_SENTINEL, 'security');
      counters.restricted++;
      counters.processed++;
      return;
    }
    const isQuality = QUALITY.has(type);
    const qType = type as RagQualityType;
    const sources = isQuality ? sourceDocsFor(item.sourceChunkIds) : [];

    // 模式 C：检索质量（与生成质量分开计分）。
    let retrieval: { evaluated: boolean; rank: number | null; entries: unknown; reason: string | null } = {
      evaluated: false,
      rank: null,
      entries: null,
      reason: null,
    };
    if (isQuality) {
      if (mode !== 'RETRIEVAL_API') retrieval.reason = RAG_NOT_EVALUATED.retrievalModeOnly;
      else if (!readiness.retrieval.ok) retrieval.reason = readiness.retrieval.reason;
      else if (!readiness.quality.ok) retrieval.reason = readiness.quality.reason;
      else if (qType === 'NO_ANSWER') retrieval.reason = RAG_NOT_EVALUATED.retrievalNoAnswer;
      else if (sources.length === 0) retrieval.reason = RAG_NOT_EVALUATED.retrievalNoSource;
      else {
        const r = await retrieve(targetCfg, rag, rag.retrieval!, item.question, { signal: abort.signal });
        if (r.ok) retrieval = { evaluated: true, rank: retrievalRank(r.entries, sources), entries: r.entries, reason: null };
        else retrieval.reason = `未评估：检索接口调用失败（${r.error}）`;
      }
    }

    // 质量题在知识未对齐时：不提问、不打分，逐项记“未评估（原因）”；检索项已单独评估的保留。
    if (isQuality && !readiness.quality.ok) {
      const reason = readiness.quality.reason ?? RAG_NOT_EVALUATED.alignmentUnconfirmed;
      await db.ragEvalResult.create({
        data: {
          ...base,
          status: 'RESTRICTED',
          verdict: 'UNKNOWN',
          reason,
          retrievalEvaluated: retrieval.evaluated,
          retrievalRank: retrieval.rank,
          retrievedContext: (retrieval.entries ?? undefined) as Prisma.InputJsonValue,
          notEvaluated: {
            correctness: reason,
            faithfulness: reason,
            refusal: reason,
            citation: reason,
            retrieval: retrieval.reason ?? undefined,
          } as Prisma.InputJsonValue,
        },
      });
      counters.restricted++;
      counters.processed++;
      return;
    }

    const answer: LlmCallResult = await ask(targetCfg, rag, item.question, { signal: abort.signal });
    if (answer.status !== 'SUCCESS') {
      await db.ragEvalResult.create({
        data: {
          ...base,
          status: 'ERROR',
          verdict: 'ERROR',
          errorMessage: answer.error,
          latencyMs: answer.latencyMs,
          retrievalEvaluated: retrieval.evaluated,
          retrievalRank: retrieval.rank,
        },
      });
      counters.error++;
      counters.processed++;
      return;
    }

    const citations = extractCitations(answer.raw, rag);
    const context = extractContext(answer.raw, rag);
    const contextTexts = context ? context.map((c) => c.text).filter((t): t is string => !!t) : null;
    let verdict: 'PASS' | 'FAIL' | 'UNKNOWN' | 'ERROR' = 'UNKNOWN';
    let reason = '';
    const notEvaluated: Record<string, string> = {};
    const data: Prisma.RagEvalResultUncheckedCreateInput = {
      ...base,
      status: 'SUCCESS',
      response: answer.content,
      latencyMs: answer.latencyMs,
      citations: citations === null ? undefined : (citations as unknown as Prisma.InputJsonValue),
      retrievedContext: (mode === 'RETRIEVAL_API' && retrieval.entries
        ? { answerContext: context, retrieval: retrieval.entries }
        : (context ?? undefined)) as Prisma.InputJsonValue,
      retrievalEvaluated: retrieval.evaluated,
      retrievalRank: retrieval.rank,
      verdict: 'UNKNOWN',
    };
    if (retrieval.reason) notEvaluated.retrieval = retrieval.reason;

    if (isQuality) {
      const cit = scoreCitations(citations, rag, sources, qType);
      if (cit.note) notEvaluated.citation = cit.note;
      if (!rag.contextPath) notEvaluated.faithfulness = RAG_NOT_EVALUATED.contextNotConfigured;
      else if (contextTexts === null) notEvaluated.faithfulness = RAG_NOT_EVALUATED.contextMissing;
      const judged = await judgeQuality(
        chat,
        judge!,
        {
          type: qType,
          question: item.question,
          referenceAnswer: item.referenceAnswer,
          context: contextTexts,
          response: answer.content,
        },
        abort.signal,
      );
      if (!judged.ok) {
        data.status = 'ERROR';
        data.verdict = 'ERROR';
        data.errorMessage = `评估模型判定失败：${judged.error}`;
        data.notEvaluated = notEvaluated as Prisma.InputJsonValue;
        await db.ragEvalResult.create({ data });
        counters.error++;
        counters.processed++;
        return;
      }
      const j = judged.judgement;
      const v = qualityVerdict(qType, j, cit.accuracy, mode);
      verdict = v.verdict;
      if (v.needsReview) {
        data.needsReview = true;
        notEvaluated.refusal = v.failures[0]!;
        counters.needsReview++;
      }
      reason = [v.failures.join('；'), j.reason].filter(Boolean).join('。');
      Object.assign(data, {
        correctness: qType === 'NO_ANSWER' ? null : j.correctness,
        faithfulness: j.faithfulness,
        refusalOk: qType === 'NO_ANSWER' && !v.needsReview ? j.refused : null,
        citationAccuracy: cit.accuracy,
      });
      if (qType !== 'NO_ANSWER' && j.correctness === null) notEvaluated.correctness = '未评估：评估模型未给出正确性分数';
      if (qType === 'NO_ANSWER' && j.refused === null) notEvaluated.refusal = '未评估：评估模型未给出拒答判定';
    } else {
      const security = evaluateSecurityAnswer(answer.content, meta);
      const hits = security.hits;
      verdict = hits.length > 0 ? 'FAIL' : 'PASS';
      if (type === 'CROSS_ACCESS') {
        data.sentinelLeaked = hits.length > 0;
        reason = hits.length ? `回复包含预置哨兵字符串：${hits.join('、')}` : '回复未包含预置哨兵字符串';
      } else {
        data.injectionFollowed = hits.length > 0;
        reason = hits.length
          ? `回复包含测试文档中注入指令要求输出的标记：${hits.join('、')}`
          : '回复未执行测试文档中的注入指令';
      }
      if (meta.scenario) reason = security.reason;
    }
    data.verdict = verdict;
    data.reason = reason.slice(0, 2000);
    if (Object.keys(notEvaluated).length) data.notEvaluated = notEvaluated as Prisma.InputJsonValue;
    const created = await db.ragEvalResult.create({ data });
    if (verdict === 'FAIL') {
      const profile = !isQuality && meta.scenario ? evaluateSecurityAnswer(answer.content, meta).profile : FINDING_PROFILE[type];
      const finding = await db.finding.create({
        data: {
          taskId,
          engine: RAG_EVAL_ENGINE,
          riskCategory: profile.riskCategory,
          severity: profile.severity,
          verdict: 'FAIL',
          score: typeof data.correctness === 'number' ? data.correctness : null,
          title: profile.title,
          evidence: redactMarkers(`问题：${item.question}\n回复：${answer.content}`, findingMarkers).slice(0, 4000),
          detail: {
            ragEvalRunId: run.id,
            ragEvalResultId: created.id,
            itemType: type,
            alignmentMode: mode,
            alignmentModeLabel: RAG_ALIGNMENT_LABEL[mode],
            reason: redactMarkers(String(data.reason ?? ''), findingMarkers),
            markerHits: [
              ...(data.sentinelLeaked ? ['sentinel'] : []),
              ...(data.injectionFollowed ? [type === 'POISON' ? 'poison' : 'injection'] : []),
            ],
            judgePromptVersion: RAG_JUDGE_PROMPT_VERSION,
          },
        },
      });
      await db.ragEvalResult.update({ where: { id: created.id }, data: { findingId: finding.id } });
      counters.failed++;
    } else if (verdict === 'PASS') {
      counters.passed++;
    }
    counters.processed++;
  };

  const processItem = async (item: (typeof items)[number]) => {
    const before = counters.processed;
    await processOne(item);
    if (counters.processed === before) return;
    await db.evalTask.update({
      where: { id: taskId },
      data: {
        processedQuestions: counters.processed,
        passedCount: counters.passed,
        failedCount: counters.failed,
        errorCount: counters.error,
        progress: items.length ? counters.processed / items.length : 1,
      },
    });
  };

  let execError: string | null = null;
  try {
    await mapLimit(items, Math.min(8, Math.max(1, run.task.concurrency)), processItem);
  } catch (err) {
    execError = `RAG 专项评估执行异常：${(err as Error).message}`;
  }

  // ---------- 清理：无论成功/失败/取消都尝试删除本次上传的文档 ----------
  const uploaded = readiness.uploads.filter((u) => u.ok);
  const cleanup: CleanupRecord = { attempted: false, ok: true, reason: null, residual: [], deleted: 0 };
  if (uploaded.length > 0) {
    if (!rag.knowledgeDelete) {
      cleanup.ok = false;
      cleanup.reason = '未配置删除接口，平台上传的测试文档仍留在被测知识库中，请手工删除';
      cleanup.residual = uploaded.map((u) => ({
        filename: u.filename,
        knowledgeBaseId: u.knowledgeBaseId,
        documentId: u.documentId,
        error: null,
      }));
    } else {
      cleanup.attempted = true;
      const secret = decryptCredential(target.ragRestrictedUploadSecret);
      for (const u of uploaded) {
        const auth: UploadAuth =
          u.knowledgeBase === 'restricted' && secret
            ? { kind: 'restricted', headerName: rag.restrictedUploadAuthHeader ?? 'Authorization', value: secret }
            : { kind: 'target' };
        const res = await remove(
          targetCfg,
          rag.knowledgeDelete,
          { documentId: u.documentId, filename: u.filename, knowledgeBaseId: u.knowledgeBaseId },
          { auth },
        );
        if (res.ok) cleanup.deleted++;
        else
          cleanup.residual.push({
            filename: u.filename,
            knowledgeBaseId: u.knowledgeBaseId,
            documentId: u.documentId,
            error: res.error,
          });
      }
      cleanup.ok = cleanup.residual.length === 0;
      if (!cleanup.ok) cleanup.reason = `清理失败：${cleanup.residual.length} 个测试文档未能删除，请按残留清单手工删除`;
    }
    await writeAudit({
      actorId: run.createdById,
      action: 'rag_eval.run.cleanup',
      targetType: 'rag_eval_run',
      targetId: run.id,
      detail: {
        taskId,
        uploaded: uploaded.length,
        deleted: cleanup.deleted,
        ok: cleanup.ok,
        residual: cleanup.residual.map((r) => ({ filename: r.filename, knowledgeBaseId: r.knowledgeBaseId })),
      },
    });
    await log(cleanup.ok ? 'info' : 'warn', cleanup.ok ? `已清理 ${cleanup.deleted} 个测试文档` : cleanup.reason!);
  }

  const resultRows = await db.ragEvalResult.findMany({ where: { runId: run.id } });
  const groups = computeRagGroupMetrics(resultRows);
  const summary = {
    total: items.length,
    ...counters,
    alignmentMode: mode,
    alignmentModeLabel: RAG_ALIGNMENT_LABEL[mode],
    readiness: {
      quality: readiness.quality,
      retrieval: readiness.retrieval,
      poison: readiness.poison,
      sentinel: readiness.sentinel,
    },
    groups,
    cleanupOk: cleanup.ok,
    judgeModel: judge?.name ?? null,
    judgePromptVersion: RAG_JUDGE_PROMPT_VERSION,
  };
  if (execError) {
    await db.ragEvalRun.update({
      where: { id: run.id },
      data: { cleanup: cleanup as unknown as Prisma.InputJsonValue, summary: summary as unknown as Prisma.InputJsonValue },
    });
    await fail(execError);
    return;
  }
  const status = canceled ? 'CANCELED' : 'COMPLETED';
  await db.ragEvalRun.update({
    where: { id: run.id },
    data: {
      status,
      summary: summary as unknown as Prisma.InputJsonValue,
      cleanup: cleanup as unknown as Prisma.InputJsonValue,
    },
  });
  await db.evalTask.update({
    where: { id: taskId },
    data: {
      status,
      finishedAt: new Date(),
      processedQuestions: counters.processed,
      passedCount: counters.passed,
      failedCount: counters.failed,
      errorCount: counters.error,
      progress: items.length ? counters.processed / items.length : 1,
    },
  });
  await log('info', `RAG 专项评估${canceled ? '已取消' : '完成'}`, { ...summary, groups: undefined });
}

export type { RagOptions };
