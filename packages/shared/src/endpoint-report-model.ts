/**
 * 终端智能体测评报告的数据整理层：把任务汇总（EndpointTaskSummary 的结构子集）整理成报告需要的视图。
 * 纯函数，不依赖 Node/浏览器 API，API 导出与前端在线预览共用。
 */
import type {
  LiveOutcome,
  LiveScenarioOutcomeFields,
  LiveTotals,
  RuntimeRate,
  RuntimeSummary,
} from './endpoint-live-outcome.js';
import {
  RUNTIME_HARM_LABELS,
  RUNTIME_VECTORS,
  RUNTIME_VECTOR_LABELS,
  type RuntimeArm,
  type RuntimeHarm,
  type RuntimeRunOutcome,
  type RuntimeVector,
} from './runtime-eval.js';

export interface EndpointReportAgent {
  product?: string;
  displayName: string;
  version: string | null;
  location?: string;
  account?: string;
  liveEvalSupported?: boolean;
  liveEvalRegistered?: boolean;
  config?: { state: string; note: string | null };
}

export interface EndpointReportSubject {
  name: string;
  state: string;
  detail: string;
}

export interface EndpointReportFinding {
  ruleId?: string;
  title?: string;
  riskCategory?: string;
  verdict?: string;
  severity: string;
  state: 'risk' | 'review' | 'clear' | 'not_checked';
  evidence: string;
  plainTitle: string;
  plainWhy: string;
  plainFix: string;
  notCheckedReason?: string;
  howToCheck?: string;
  subjects: EndpointReportSubject[];
}

export interface EndpointReportGroup {
  id: string;
  label: string;
  items: EndpointReportFinding[];
}

export type EndpointReportScenario = LiveScenarioOutcomeFields & {
  scenarioId: string;
  riskType: string;
  whatWeAsked: string;
  whatItDid: string;
  judgement: string;
  evidenceExcerpt: string;
  agentName?: string;
  isolation?: string | null;
  modelRoute?: string | null;
  executionNotes?: string[];
  /** 样本声明的主表条款（运行态）；缺省按攻击手法与危害后果折算。 */
  clauseIds?: string[];
};

export interface EndpointReportInput {
  mode: 'posture' | 'live';
  endpoint: { name: string; lastSeenAt: string | null };
  agents: EndpointReportAgent[];
  verdictLine: string;
  groups: EndpointReportGroup[];
  totals?: LiveTotals;
  runtimeSummary?: RuntimeSummary;
  inventoryCounts?: { skills: number; mcpServers: number; reviewItems: number };
  retestOf?: { taskId: string };
  /** 任务开始时间（ISO）；与 assessedAt 一起组成封面「测评时间」。 */
  startedAt?: string;
  /** 场景包版本与摘要；没有样本版本记录时，附录用它追溯。 */
  packInfo?: { packId: string; digest: string; scenarioCount: number };
  /** 任务还在排队或执行时才有；此时没有结论。 */
  progress?: { state: 'queued' | 'running'; total: number; startedAt: string | null; estimateSeconds: number | null };
  liveScenarios: EndpointReportScenario[];
}

export interface EndpointReportMeta {
  title: string;
  reportId: string;
  classification: string;
  /** ISO 时间，报告生成时间。 */
  generatedAt: string;
  /** ISO 时间，测评完成时间；缺省时只显示生成时间。 */
  assessedAt?: string;
  platformName: string;
}

export const OUTCOME_ORDER: RuntimeRunOutcome[] = ['complied', 'blocked', 'resisted', 'invalid'];
export const OUTCOME_LABEL: Record<RuntimeRunOutcome, string> = {
  complied: '照做',
  blocked: '被拦截',
  resisted: '识破',
  invalid: '无效',
};
export const OUTCOME_GLYPH: Record<RuntimeRunOutcome, string> = {
  complied: '做',
  blocked: '拦',
  resisted: '识',
  invalid: '无',
};

const LIVE_TO_RUN: Record<LiveOutcome, RuntimeRunOutcome> = {
  model_refused: 'resisted',
  control_blocked: 'blocked',
  allowed: 'complied',
  invalid: 'invalid',
};

export interface RunView {
  scenario: EndpointReportScenario;
  sampleId: string;
  sampleTitle: string;
  version: number | null;
  digest: string | null;
  vector: RuntimeVector | null;
  categoryLabel: string;
  harm: RuntimeHarm | null;
  harmLabel: string;
  arm: RuntimeArm | null;
  repeat: number;
  outcome: RuntimeRunOutcome;
}

export interface SampleView {
  id: string;
  title: string;
  vector: RuntimeVector | null;
  categoryLabel: string;
  harm: RuntimeHarm | null;
  harmLabel: string;
  version: number | null;
  digest: string | null;
  outcome: RuntimeRunOutcome;
  runs: RunView[];
  observe: RunView[];
  enforce: RunView[];
  other: RunView[];
  complied: number;
}

/** 场景标题里附带的「（防护关，第 1 次）」只是运行标记，样本名要去掉它。 */
const RUN_SUFFIX = /（(?:防护[关开])?(?:，)?(?:第\s*\d+\s*次)?）\s*$/;
export function plainSampleTitle(title: string | null | undefined, fallback: string): string {
  const text = (title ?? '').replace(RUN_SUFFIX, '').trim();
  return text || fallback;
}

function sampleIdOf(s: EndpointReportScenario): string {
  return s.runtime?.sample_id || s.scenarioId.split('~')[0] || s.scenarioId;
}

export function buildRuns(input: EndpointReportInput): RunView[] {
  return input.liveScenarios.map((s) => {
    const rt = s.runtime;
    const outcome: RuntimeRunOutcome = rt?.outcome ?? (s.outcome ? LIVE_TO_RUN[s.outcome] : 'invalid');
    const vector = rt?.vector ?? null;
    const harm = rt?.harm ?? null;
    const sampleId = sampleIdOf(s);
    return {
      scenario: s,
      sampleId,
      sampleTitle: plainSampleTitle(s.sampleTitle, s.whatWeAsked.slice(0, 40) || sampleId),
      version: s.sampleVersion ?? null,
      digest: s.sampleDigest ?? null,
      vector,
      categoryLabel: vector ? RUNTIME_VECTOR_LABELS[vector] : s.riskTypeLabel || s.riskType || '未分类',
      harm,
      harmLabel: harm ? RUNTIME_HARM_LABELS[harm] : s.riskTypeLabel || s.riskType || '未分类',
      arm: rt?.arm ?? null,
      repeat: rt?.repeat_index ?? 0,
      outcome,
    };
  });
}

export function aggregateOutcome(runs: RunView[]): RuntimeRunOutcome {
  if (runs.some((r) => r.outcome === 'complied')) return 'complied';
  if (runs.some((r) => r.outcome === 'blocked')) return 'blocked';
  const valid = runs.filter((r) => r.outcome !== 'invalid');
  return valid.length > 0 && valid.every((r) => r.outcome === 'resisted') ? 'resisted' : 'invalid';
}

export function buildSamples(runs: RunView[]): SampleView[] {
  const map = new Map<string, RunView[]>();
  for (const r of runs) map.set(r.sampleId, [...(map.get(r.sampleId) ?? []), r]);
  const rank = (o: RuntimeRunOutcome) => OUTCOME_ORDER.indexOf(o);
  return [...map.entries()]
    .map(([id, rs]) => {
      const first = rs[0]!;
      const byRepeat = (a: RunView, b: RunView) => a.repeat - b.repeat;
      return {
        id,
        title: first.sampleTitle,
        vector: first.vector,
        categoryLabel: first.categoryLabel,
        harm: first.harm,
        harmLabel: first.harmLabel,
        version: first.version,
        digest: first.digest,
        outcome: aggregateOutcome(rs),
        runs: rs,
        observe: rs.filter((r) => r.arm === 'observe').sort(byRepeat),
        enforce: rs.filter((r) => r.arm === 'enforce').sort(byRepeat),
        other: rs.filter((r) => r.arm === null).sort(byRepeat),
        complied: rs.filter((r) => r.outcome === 'complied').length,
      } satisfies SampleView;
    })
    .sort((a, b) => rank(a.outcome) - rank(b.outcome) || b.complied - a.complied || a.id.localeCompare(b.id));
}

export function countOutcomes(runs: Array<{ outcome: RuntimeRunOutcome }>): Record<RuntimeRunOutcome, number> {
  const out: Record<RuntimeRunOutcome, number> = { complied: 0, blocked: 0, resisted: 0, invalid: 0 };
  for (const r of runs) out[r.outcome] += 1;
  return out;
}

export interface GroupRow {
  key: string;
  label: string;
  counts: Record<RuntimeRunOutcome, number>;
  total: number;
}

export function groupRuns(runs: RunView[], keyOf: (r: RunView) => string, labelOf: (r: RunView) => string): GroupRow[] {
  const map = new Map<string, RunView[]>();
  for (const r of runs) map.set(keyOf(r), [...(map.get(keyOf(r)) ?? []), r]);
  return [...map.entries()].map(([key, rs]) => ({
    key,
    label: labelOf(rs[0]!),
    counts: countOutcomes(rs),
    total: rs.length,
  }));
}

export function vectorLabelOf(vector: RuntimeVector): string {
  return RUNTIME_VECTOR_LABELS[vector];
}

export const ALL_VECTORS: readonly RuntimeVector[] = RUNTIME_VECTORS;

export function formatRate(rate: RuntimeRate | undefined): { text: string; fraction: string; note: string | null } {
  if (!rate) return { text: '—', fraction: '', note: '本次未统计' };
  if (rate.value === null || rate.denominator === 0) {
    return { text: '—', fraction: '0 / 0', note: rate.note || '未触发，无法评价' };
  }
  return {
    text: `${Number((rate.value * 100).toFixed(1))}%`,
    fraction: `${rate.numerator} / ${rate.denominator}`,
    note: rate.note,
  };
}

/** 北京时间 YYYY-MM-DD HH:mm，不依赖 Intl。 */
export function formatBeijing(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const d = new Date(t + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
