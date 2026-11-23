import type { LlmCallResult } from '@lse/shared';
import type { EvaluationTargetConfig } from '../eval-targets/invoker.js';
import { RAG_INDEX_DEFAULTS, type RagOptions } from './options.js';
import {
  askRagTarget,
  extractContext,
  retrieveFromTarget,
  type ContextEntry,
} from './target-client.js';
import { extractCitations } from './rag-judge.js';
import { normalizeText } from './text-search.js';

export interface ProbeDoc {
  manifestId: string;
  filename: string;
  probe: string;
  /** 文档正文中除探针外的一段特征文本，用于“只返回回答文本”的被测系统判定命中。 */
  fingerprint: string;
}

export interface ProbeDeps {
  ask?: typeof askRagTarget;
  retrieve?: typeof retrieveFromTarget;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  isCanceled?: () => Promise<boolean>;
}

export interface IndexProbeResult {
  ready: boolean;
  hitRate: number;
  threshold: number;
  attempts: number;
  elapsedMs: number;
  timeoutSec: number;
  docs: Array<{ manifestId: string; filename: string; hit: boolean; via: string | null }>;
  error: string | null;
}

export function probeQuestion(probe: string): string {
  return `请检索知识库中包含“LSE 索引探针编号：${probe}”的文档，并原文复述该文档探针行之后的第一句话。`;
}

/** 取文档正文中第一段非探针、非标题的特征文本（去掉 Markdown 标记，≤40 字）。 */
export function docFingerprint(content: string): string {
  for (const raw of content.split('\n')) {
    const line = raw.replace(/^[#>\s*-]+/, '').trim();
    if (!line || line.includes('LSE-PROBE-') || line.includes('LSE 索引探针')) continue;
    if (normalizeText(line).length < 8) continue;
    return line.slice(0, 40);
  }
  return '';
}

function entriesHit(entries: ContextEntry[] | null, doc: ProbeDoc): boolean {
  if (!entries) return false;
  const probe = doc.probe.toLowerCase();
  return entries.some(
    (e) =>
      (e.text && e.text.toLowerCase().includes(probe)) ||
      (e.id && [doc.manifestId, doc.filename].some((k) => k.toLowerCase() === e.id!.toLowerCase())),
  );
}

/** 判定一次提问是否说明被测系统已检索到该文档：检索上下文/引用含探针或文档标识，或回答复述了特征文本。 */
export function probeHit(answer: LlmCallResult, rag: RagOptions, doc: ProbeDoc): string | null {
  if (answer.status !== 'SUCCESS') return null;
  if (entriesHit(extractContext(answer.raw, rag), doc)) return 'context';
  if (entriesHit(extractCitations(answer.raw, rag), doc)) return 'citation';
  const fp = normalizeText(doc.fingerprint);
  if (fp.length >= 8 && normalizeText(answer.content).includes(fp.slice(0, Math.min(fp.length, 16))))
    return 'answer';
  return null;
}

/**
 * 索引就绪探测：对每个已导入文档用唯一探针短语提问（配置了检索接口则直接检索），
 * 命中率 ≥ 阈值即就绪；未达到则按间隔重试直到超时。只对测试身份可访问的文档探测。
 */
export async function waitForIndexReady(
  target: EvaluationTargetConfig,
  rag: RagOptions,
  docs: ProbeDoc[],
  deps: ProbeDeps = {},
): Promise<IndexProbeResult> {
  const ask = deps.ask ?? askRagTarget;
  const retrieve = deps.retrieve ?? retrieveFromTarget;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const timeoutSec = rag.indexWaitTimeoutSec ?? RAG_INDEX_DEFAULTS.timeoutSec;
  const pollMs = (rag.indexPollIntervalSec ?? RAG_INDEX_DEFAULTS.pollSec) * 1000;
  const threshold = rag.indexReadyThreshold ?? RAG_INDEX_DEFAULTS.threshold;
  const started = now();
  const hits = new Map<string, string>();
  const probeable = docs.filter((d) => d.probe);
  let attempts = 0;
  let error: string | null = null;
  const snapshot = (ready: boolean): IndexProbeResult => ({
    ready,
    hitRate: probeable.length ? hits.size / probeable.length : 0,
    threshold,
    attempts,
    elapsedMs: now() - started,
    timeoutSec,
    docs: probeable.map((d) => ({
      manifestId: d.manifestId,
      filename: d.filename,
      hit: hits.has(d.manifestId),
      via: hits.get(d.manifestId) ?? null,
    })),
    error,
  });
  if (probeable.length === 0) {
    error = '没有可探测的文档';
    return snapshot(false);
  }
  for (;;) {
    attempts++;
    for (const d of probeable) {
      if (hits.has(d.manifestId)) continue;
      if (rag.retrieval) {
        const r = await retrieve(target, rag, rag.retrieval, d.probe);
        if (r.ok && entriesHit(r.entries, d)) hits.set(d.manifestId, 'retrieval');
        else if (!r.ok) error = r.error;
        continue;
      }
      const answer = await ask(target, rag, probeQuestion(d.probe), { timeoutMs: 60_000 });
      const via = probeHit(answer, rag, d);
      if (via) hits.set(d.manifestId, via);
      else if (answer.status !== 'SUCCESS') error = answer.error ?? '被测接口调用失败';
    }
    if (hits.size / probeable.length >= threshold) {
      error = null;
      return snapshot(true);
    }
    if (deps.isCanceled && (await deps.isCanceled())) {
      error = '已取消';
      return snapshot(false);
    }
    if (now() - started + pollMs > timeoutSec * 1000) {
      error ??= `等待 ${timeoutSec} 秒后命中率仍未达到阈值`;
      return snapshot(false);
    }
    await sleep(pollMs);
  }
}
