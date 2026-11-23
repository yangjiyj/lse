import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { CorpusScan, Prisma } from '@prisma/client';
import { ANNEX_A_ITEMS } from '@lse/shared';
import { prisma } from '../../db.js';
import { chatComplete } from '../../lib/llm-client.js';
import type { RagChatCaller, ResolvedJudge } from '../rag-eval/judge-model.js';
import type { CustomRule, RuleKind, RuleSeverity } from './core/custom-rules.js';
import type { Container, CorpusFormat } from './core/formats.js';
import { createCorpusMasker } from './core/mask.js';
import {
  MAX_STORED_FINDINGS,
  createScanSession,
  type CorpusFindingOut,
  type ScanRecord,
} from './core/scan.js';
import {
  JUDGE_MAX_CONSECUTIVE_FAILURES,
  JUDGE_TEXT_MAX,
  JUDGE_TIME_BUDGET_MS,
  judgeRecord,
  resolveCorpusJudge,
  type JudgeCandidate,
} from './judge.js';
import { corpusFilePath, corpusRetentionDays, removeCorpusFile } from './storage.js';

// 语料扫描执行（worker）：PENDING → RUNNING → COMPLETED / FAILED。
// 流式逐块读文件、逐条记录检测（处理中定时让出事件循环）；命中按批写库，最多存 50,000 条，超出只计数；
// 扫完再读一遍原文件生成打码副本（与原文件同目录，uuid 命名），下载时直接发这个文件；可选裁判复核。
// 扫描被删除时（行不在了）安静退出。worker 启动时把上次没跑完的（RUNNING）置为失败；
// 每天清理超过保留天数的原文件和打码副本，扫描结果保留。

export interface CorpusScanDeps {
  /** 测试注入：裁判模型调用器 */
  chat?: RagChatCaller;
  /** 测试注入：裁判模型（null 表示没配置）；不给就按扫描所属租户解析 */
  judge?: ResolvedJudge | null;
  /** 测试注入：复核总时长上限（毫秒） */
  judgeTimeBudgetMs?: number;
}

export const CORPUS_SCAN_INTERRUPTED = '扫描被中断，请重新发起';

const FLUSH_BATCH = 1000;
const PROGRESS_INTERVAL_MS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CODE_LABELS: Record<string, string> = Object.fromEntries(
  ANNEX_A_ITEMS.map((i) => [i.code, i.name]),
);

class ScanGone extends Error {}

/**
 * 违规检测用的国标关键词：平台共享的加扫描所属租户自己的，只用生效的词（候选、停用、已剔除的不用），
 * 与国标判定口径一致。命令行版的关键词导出也用它。
 */
export async function loadScanKeywords(
  tenantId: string | null,
): Promise<{ term: string; code: string }[]> {
  const rows = await prisma.standardKeyword.findMany({
    where: {
      OR: tenantId ? [{ tenantId: null }, { tenantId }] : [{ tenantId: null }],
      reviewStatus: 'approved',
    },
    select: { term: true, itemCode: true },
    // 固定顺序：命令行版用导出的同一份词表时结果完全一致
    orderBy: [{ itemCode: 'asc' }, { term: 'asc' }, { id: 'asc' }],
  });
  return rows.map((r) => ({ term: r.term, code: r.itemCode }));
}

export async function loadScanRules(ruleSetId: string | null): Promise<CustomRule[]> {
  if (!ruleSetId) return [];
  const rows = await prisma.corpusRule.findMany({
    where: { ruleSetId, enabled: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as RuleKind,
    pattern: r.pattern,
    category: r.category,
    severity: r.severity as RuleSeverity,
    enabled: r.enabled,
  }));
}

function recordText(rec: ScanRecord): string {
  const text = rec.fields.map((f) => `${f.path}：${f.text}`).join('\n');
  return text.length > JUDGE_TEXT_MAX ? `${text.slice(0, JUDGE_TEXT_MAX)}…` : text;
}

/** 读一遍原文件生成打码副本。先登记 key 再写文件：生成期间扫描被删除时，删除接口能一并删掉它。 */
async function writeMaskedCopy(scan: CorpusScan, container: Container): Promise<void> {
  const maskedKey = randomUUID();
  const claimed = await prisma.corpusScan.updateMany({
    where: { id: scan.id, status: 'RUNNING' },
    data: { maskedKey },
  });
  if (claimed.count === 0) throw new ScanGone();
  const dest = corpusFilePath(maskedKey);
  const masker = createCorpusMasker(container);
  try {
    await pipeline(
      createReadStream(corpusFilePath(scan.storageKey), {
        encoding: 'utf8',
        highWaterMark: 1 << 20,
      }),
      async function* (source: AsyncIterable<string>) {
        for await (const chunk of source) {
          const out = masker.push(chunk);
          if (out) yield out;
        }
        const rest = masker.end();
        if (rest) yield rest;
      },
      createWriteStream(dest, { flags: 'wx', mode: 0o600 }),
    );
  } catch (e) {
    await rm(dest, { force: true });
    throw e;
  }
}

async function execute(scan: CorpusScan, deps: CorpusScanDeps) {
  const [keywords, rules] = await Promise.all([
    loadScanKeywords(scan.tenantId),
    loadScanRules(scan.ruleSetId),
  ]);
  const judgeLimit = scan.judgeReview ? scan.judgeLimit : 0;
  const candidates: JudgeCandidate[] = [];
  let violationRecords = 0;
  const csvColumns = Array.isArray(scan.csvColumns) ? (scan.csvColumns as string[]) : undefined;
  const session = createScanSession(
    { format: scan.format as CorpusFormat, fileName: scan.fileName, csvColumns },
    { keywords, codeLabels: CODE_LABELS, customRules: rules },
    {
      onViolationRecord: (rec, found) => {
        violationRecords += 1;
        if (candidates.length < judgeLimit) {
          candidates.push({
            recordIndex: rec.index,
            text: recordText(rec),
            keywords: [...new Set(found.map((f) => f.matchText))],
          });
        }
      },
    },
  );

  let stored = 0;
  const buffer: CorpusFindingOut[] = [];
  const flush = async () => {
    if (buffer.length === 0) return;
    const rows = buffer.splice(0, buffer.length);
    await prisma.corpusFinding.createMany({
      data: rows.map((f) => ({ ...f, scanId: scan.id, tenantId: scan.tenantId })),
    });
  };
  const take = async (found: CorpusFindingOut[]) => {
    for (const f of found) {
      if (stored >= MAX_STORED_FINDINGS) break;
      buffer.push(f);
      stored += 1;
    }
    if (buffer.length >= FLUSH_BATCH) await flush();
  };

  const stream = createReadStream(corpusFilePath(scan.storageKey), {
    encoding: 'utf8',
    highWaterMark: 1 << 20,
  });
  let last = Date.now();
  try {
    for await (const chunk of stream) {
      await take(await session.pushAsync(chunk as string));
      if (Date.now() - last >= PROGRESS_INTERVAL_MS) {
        last = Date.now();
        const r = await prisma.corpusScan.updateMany({
          where: { id: scan.id, status: 'RUNNING' },
          data: { progressBytes: BigInt(stream.bytesRead) },
        });
        if (r.count === 0) throw new ScanGone();
      }
    }
  } finally {
    stream.destroy();
  }
  await take(await session.endAsync());
  await flush();
  const stats = session.stats();

  if (stats.container) await writeMaskedCopy(scan, stats.container);

  let judgeReviewed = 0;
  let judgeNote: string | null = null;
  if (scan.judgeReview) {
    if (candidates.length === 0) judgeNote = '没有违规命中，无需复核';
    else {
      const judge = deps.judge !== undefined ? deps.judge : await resolveCorpusJudge(scan.tenantId);
      if (!judge) judgeNote = '未配置裁判模型，未复核';
      else {
        const chat = deps.chat ?? chatComplete;
        const budget = deps.judgeTimeBudgetMs ?? JUDGE_TIME_BUDGET_MS;
        const startedAt = Date.now();
        let failed = 0;
        let consecutive = 0;
        let stopped: string | null = null;
        for (const c of candidates) {
          if (Date.now() - startedAt >= budget) {
            stopped = '复核用时达到上限，已停止';
            break;
          }
          const r = await judgeRecord(chat, judge, c);
          judgeReviewed += 1;
          if (r.verdict === 'ERROR') {
            failed += 1;
            consecutive += 1;
          } else consecutive = 0;
          await prisma.corpusFinding.updateMany({
            where: { scanId: scan.id, recordIndex: c.recordIndex, category: 'violation' },
            data: { judgeVerdict: r.verdict, judgeReason: r.reason },
          });
          if (consecutive >= JUDGE_MAX_CONSECUTIVE_FAILURES) {
            stopped = `连续 ${JUDGE_MAX_CONSECUTIVE_FAILURES} 次复核失败，已停止复核`;
            break;
          }
        }
        judgeNote = `由「${judge.name}」复核 ${judgeReviewed} 条记录`;
        if (failed > 0) judgeNote += `，其中 ${failed} 条复核失败`;
        if (stopped) judgeNote += `；${stopped}，${candidates.length - judgeReviewed} 条没有复核`;
        if (violationRecords > candidates.length)
          judgeNote += `；违规记录共 ${violationRecords} 条，超出上限的没有复核`;
      }
    }
  }

  return {
    detectedFormat: stats.detectedFormat,
    container: stats.container,
    totalRecords: stats.totalRecords,
    invalidRecords: stats.invalidRecords,
    findingCount: stats.findingCount,
    storedFindings: stored,
    truncated: stats.findingCount > stored,
    stats: stats as unknown as Prisma.InputJsonValue,
    judgeReviewed,
    judgeNote,
    progressBytes: scan.bytes,
  };
}

/** worker 入口：只有抢到 PENDING 的执行者才处理（重复投递幂等）。 */
export async function runCorpusScan(scanId: string, deps: CorpusScanDeps = {}): Promise<void> {
  const claimed = await prisma.corpusScan.updateMany({
    where: { id: scanId, status: 'PENDING' },
    data: { status: 'RUNNING', startedAt: new Date() },
  });
  if (claimed.count === 0) return;
  const scan = await prisma.corpusScan.findUnique({ where: { id: scanId } });
  if (!scan) return;
  try {
    const result = await execute(scan, deps);
    await prisma.corpusScan.updateMany({
      where: { id: scanId, status: 'RUNNING' },
      data: { ...result, status: 'COMPLETED', finishedAt: new Date() },
    });
  } catch (e) {
    if (e instanceof ScanGone) return;
    const message = e instanceof Error ? e.message : String(e);
    await prisma.corpusScan
      .updateMany({
        where: { id: scanId, status: 'RUNNING' },
        data: { status: 'FAILED', error: message.slice(0, 1000), finishedAt: new Date() },
      })
      .catch(() => undefined);
  }
}

/**
 * worker 启动时调用：上次进程退出（重启、崩溃、发布）时还在跑的扫描不会再有人接着跑
 * （BullMQ 重投后 runCorpusScan 抢不到 PENDING），置为失败让用户重新发起。
 * 只处理 before 之前开始的，不碰本进程启动后新抢到的。
 */
export async function failInterruptedCorpusScans(before: Date): Promise<number> {
  const r = await prisma.corpusScan.updateMany({
    where: { status: 'RUNNING', OR: [{ startedAt: null }, { startedAt: { lt: before } }] },
    data: { status: 'FAILED', error: CORPUS_SCAN_INTERRUPTED, finishedAt: new Date() },
  });
  return r.count;
}

/** 删除超过保留天数（CORPUS_RETENTION_DAYS）的原文件和打码副本，扫描记录和命中保留。 */
export async function purgeExpiredCorpusFiles(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - corpusRetentionDays() * DAY_MS);
  const rows = await prisma.corpusScan.findMany({
    where: {
      filesPurgedAt: null,
      status: { in: ['COMPLETED', 'FAILED'] },
      finishedAt: { lt: cutoff },
    },
    select: { id: true, storageKey: true, maskedKey: true },
  });
  for (const row of rows) {
    await removeCorpusFile(row.storageKey);
    await removeCorpusFile(row.maskedKey);
    await prisma.corpusScan.updateMany({ where: { id: row.id }, data: { filesPurgedAt: now } });
  }
  return rows.length;
}
