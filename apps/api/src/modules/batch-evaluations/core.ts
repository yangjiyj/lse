import { createHash } from 'node:crypto';

export const BATCH_POLICY_VERSION = 'batch-evaluation-v1';
export type BatchStrategy = 'ROUND_ROBIN' | 'SEQUENTIAL' | 'PARALLEL';

export function batchVerdict(
  results: readonly { verdict: string; status: string }[],
): 'PASS' | 'FAIL' | 'UNKNOWN' | 'ERROR' {
  if (results.some((r) => r.status === 'success' && r.verdict === 'FAIL')) return 'FAIL';
  if (results.some((r) => r.status !== 'success')) return 'UNKNOWN';
  const primary = results[0]?.verdict;
  return primary === 'PASS' || primary === 'FAIL' || primary === 'ERROR' ? primary : 'UNKNOWN';
}

export function strictJudgeContent(content: string): string | null {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  try {
    const value = JSON.parse(fenced?.[1] ?? trimmed) as Record<string, unknown>;
    if (
      !value ||
      Array.isArray(value) ||
      !['PASS', 'FAIL', 'UNKNOWN'].includes(String(value.verdict))
    )
      return null;
    return JSON.stringify({
      verdict: value.verdict,
      score: typeof value.score === 'number' && Number.isFinite(value.score) ? value.score : null,
      reason: typeof value.reason === 'string' ? value.reason.slice(0, 4000) : null,
      ...(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(String(value.severity))
        ? { severity: value.severity }
        : {}),
    });
  } catch {
    return null;
  }
}
export interface SampleInput {
  id: string;
  content: string;
  type: string;
  language: string;
  category?: string | null;
  shouldRefuse: boolean;
  expectedBehavior?: string | null;
  referenceAnswer?: string | null;
  severity?: string | null;
  metadata?: unknown;
}

export function fingerprint(value: unknown): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, item]) => [k, stable(item)]),
      );
    return v;
  };
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}

export function targetFingerprint(target: {
  targetType: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  defaultParams?: unknown;
  extraHeaders?: unknown;
  accessConfig?: unknown;
}): string {
  return fingerprint({
    targetType: target.targetType,
    baseUrl: target.baseUrl,
    apiKey: target.apiKey,
    model: target.model,
    defaultParams: target.defaultParams ?? null,
    extraHeaders: target.extraHeaders ?? null,
    accessConfig: target.accessConfig ?? null,
  });
}

export function selectSamples<T extends SampleInput>(
  input: readonly T[],
  count: number,
  seed: string,
): T[] {
  if (!Number.isInteger(count) || count < 1 || count > 100000)
    throw new Error('每对象样本数需为 1 至 100000');
  const unique = new Map<string, T>();
  for (const item of input) {
    if (!item.content.trim()) continue;
    const metadata =
      item.metadata && typeof item.metadata === 'object'
        ? (item.metadata as Record<string, unknown>)
        : {};
    if (
      ['red_team', 'agent_runtime', 'mcp_runtime', 'comprehensive'].includes(String(metadata.kind))
    )
      throw new Error('批量 API 评估不能使用智能体或自主红队专用样本');
    const key = fingerprint([item.language, item.content.trim()]);
    const prior = unique.get(key);
    const rules = (q: T) =>
      fingerprint([
        q.type,
        q.shouldRefuse,
        q.expectedBehavior ?? null,
        q.referenceAnswer ?? null,
        q.metadata && typeof q.metadata === 'object'
          ? Object.fromEntries(
              Object.entries(q.metadata).filter(([k]) => /keyword|indicator|marker/i.test(k)),
            )
          : null,
      ]);
    if (prior && rules(prior) !== rules(item))
      throw new Error('重复样本的判定规则冲突，请先整理样本库');
    if (!prior) unique.set(key, structuredClone(item));
  }
  if (unique.size < count)
    throw new Error(`有效样本不足：去重后 ${unique.size} 个，要求 ${count} 个`);
  const groups = new Map<string, T[]>();
  for (const item of unique.values()) {
    const key = `${item.category ?? item.type}:${item.language}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const ordered = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, items]) =>
      items.sort((a, b) => fingerprint([seed, a.id]).localeCompare(fingerprint([seed, b.id]))),
    );
  const selected: T[] = [];
  let offset = 0;
  while (selected.length < count) {
    for (const group of ordered) {
      if (group[offset]) selected.push(group[offset]!);
      if (selected.length === count) break;
    }
    offset++;
  }
  return selected;
}

export function pickRuns(
  runs: readonly { id: string; remaining: number }[],
  strategy: BatchStrategy,
  cursor: number,
): string[] {
  const active = runs.filter((r) => r.remaining > 0);
  if (strategy === 'SEQUENTIAL') return active.slice(0, 1).map((r) => r.id);
  const start = runs.length ? ((cursor % runs.length) + runs.length) % runs.length : 0;
  const ordered = [...runs.slice(start), ...runs.slice(0, start)].filter((r) => r.remaining > 0);
  return (strategy === 'PARALLEL' ? ordered : ordered.slice(0, 1)).map((r) => r.id);
}

export interface BatchCounts {
  expected: number;
  processed: number;
  pass: number;
  fail: number;
  error: number;
  unknown: number;
  critical: number;
}
export function buildSummary(
  counts: BatchCounts,
  completed: boolean,
  commonRisks: { category: string; affectedTargets: number }[],
) {
  const valid = counts.pass + counts.fail;
  const coverageComplete = completed && counts.expected > 0 && valid === counts.expected;
  const state =
    counts.fail > 0
      ? ('RISK_DETECTED' as const)
      : coverageComplete
        ? ('NO_RISK_OBSERVED' as const)
        : ('INCOMPLETE' as const);
  const recommendations: string[] = [];
  if (counts.critical > 0)
    recommendations.push('优先复核高危及严重风险样本，整改后使用相同样本复测。');
  else if (counts.fail > 0)
    recommendations.push('复核风险命中及其证据，按风险类别制定整改与复测计划。');
  if (!coverageComplete)
    recommendations.push('评估证据不完整：补齐未执行、调用异常及待判定样本后再作准入判断。');
  if (coverageComplete && !counts.fail)
    recommendations.push('当前样本与可观测配置范围内未发现风险，持续开展版本变更后的回归评估。');
  return { state, coverageComplete, counts: { ...counts, valid }, commonRisks, recommendations };
}
