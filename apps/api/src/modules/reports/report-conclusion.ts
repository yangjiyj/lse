import { selectPrimaryReportResults } from './report-primary-results.js';

export const REPORT_CONCLUSION_SCHEMA_VERSION = 1 as const;
export const REPORT_CONCLUSION_POLICY_VERSION = 'report-conclusion-v1' as const;

export const REPORT_CONCLUSION_SCOPE_KINDS = ['TASK', 'RESULT_SET', 'ENGINE_RUN_SET'] as const;
export type ReportConclusionScopeKind = (typeof REPORT_CONCLUSION_SCOPE_KINDS)[number];

export const REPORT_CONCLUSION_STATES = [
  'RISK_DETECTED',
  'NO_RISK_OBSERVED',
  'INCOMPLETE',
] as const;
export type ReportConclusionState = (typeof REPORT_CONCLUSION_STATES)[number];

export const REPORT_CONCLUSION_REASON_CODES = [
  'ACTIVE_RISK_PRESENT',
  'UNEXPLAINED_FAIL_RESULT',
  'TASK_NOT_COMPLETED',
  'EMPTY_SCOPE',
  'RESULT_DETAILS_UNAVAILABLE',
  'RESULT_COUNT_MISMATCH',
  'TASK_COUNTER_MISMATCH',
  'NO_VALID_DECISION',
  'RESULT_EXECUTION_ERROR',
  'RESULT_UNKNOWN',
  'RESULT_VERDICT_MISSING',
  'ENGINE_RUN_MISSING',
  'ENGINE_RUN_NOT_TERMINAL',
  'ENGINE_RUN_FAILED',
  'ENGINE_RUN_SKIPPED',
  'ENGINE_RUN_PARTIAL_SKIP',
  'LEGACY_SNAPSHOT_MISSING',
] as const;
export type ReportConclusionReasonCode = (typeof REPORT_CONCLUSION_REASON_CODES)[number];

export interface ReportConclusionCounts {
  expected: number;
  observed: number;
  valid: number;
  pass: number;
  fail: number;
  activeFailCount: number;
  excludedFailCount: number;
  unexplainedFailCount: number;
  error: number;
  unknown: number;
  missingVerdict: number;
  modelCallError: number;
  engineRunTotal: number;
  engineRunFailed: number;
  engineRunSkipped: number;
  engineRunNonterminal: number;
  engineRunPartialSkip: number;
  skippedEvaluation: number;
  unobservedResult: number;
}

interface ReportConclusionSnapshotBase {
  schemaVersion: typeof REPORT_CONCLUSION_SCHEMA_VERSION;
  policyVersion: typeof REPORT_CONCLUSION_POLICY_VERSION;
  scopeKind: ReportConclusionScopeKind;
  taskCompleted: boolean | null;
  resultDetailsAvailable: boolean;
  taskCountersMatch: boolean | null;
  missingEngineRunCount: number;
  state: ReportConclusionState;
  coverageComplete: boolean;
  reasonCodes: ReportConclusionReasonCode[];
  passRate: number | null;
  validDecisionRate: number | null;
}

export interface DeterministicReportConclusionSnapshot extends ReportConclusionSnapshotBase {
  source: 'DETERMINISTIC_RULE';
  basis: 'ACTIVE_RISK_AND_EXECUTION_COVERAGE';
  activeRiskCount: number;
  counts: ReportConclusionCounts;
}

export interface LegacyReportConclusionSnapshot extends ReportConclusionSnapshotBase {
  source: 'LEGACY_FALLBACK';
  state: 'INCOMPLETE';
  coverageComplete: false;
  reasonCodes: ['LEGACY_SNAPSHOT_MISSING'];
  basis: null;
  activeRiskCount: null;
  counts: null;
  passRate: null;
  validDecisionRate: null;
}

export type ReportConclusionSnapshot =
  | DeterministicReportConclusionSnapshot
  | LegacyReportConclusionSnapshot;

export interface ReportConclusionTaskInput {
  status: string;
  engines?: readonly string[];
  expectedEngines?: readonly string[];
  totalQuestions: number;
  processedQuestions: number;
  passedCount: number;
  failedCount: number;
  errorCount: number;
}

export interface ReportConclusionResultInput {
  finalVerdict: string | null;
  status?: string | null;
  side?: string | null;
  controlGroupId?: string | null;
}

export interface ReportConclusionEngineRunInput {
  engine?: string | null;
  status: string;
  skippedCount: number;
  normalizedCount?: number | null;
}

/**
 * FAIL 结果必须有题级风险或人工复核的明确归因；未知归因不能被解释为安全。
 * active/excluded/unexplained 三项必须刚好覆盖本次作用域内的 FAIL 数。
 */
export interface ReportConclusionFailDisposition {
  activeFailCount: number;
  excludedFailCount: number;
  unexplainedFailCount: number;
}

export interface ReportConclusionBuildInput {
  scopeKind: ReportConclusionScopeKind;
  activeRiskCount: number;
  task?: ReportConclusionTaskInput;
  results?: readonly ReportConclusionResultInput[];
  engineRuns?: readonly ReportConclusionEngineRunInput[];
  failDisposition?: ReportConclusionFailDisposition;
}

export function reportConclusionScopeKindForReportKind(
  kind: string | null | undefined,
): ReportConclusionScopeKind {
  if (kind === 'component_vulnerability' || kind === 'service_assurance') {
    return 'ENGINE_RUN_SET';
  }
  if (
    kind === 'refusal_capability' ||
    kind === 'prompt_injection_resilience' ||
    kind === 'multilingual_coverage' ||
    kind === 'agent_tool_abuse' ||
    kind === 'usability_over_refusal'
  ) {
    return 'RESULT_SET';
  }
  return 'TASK';
}

const REASON_ORDER = new Map(
  REPORT_CONCLUSION_REASON_CODES.map((reason, index) => [reason, index] as const),
);
const COVERAGE_REASON_CODES = new Set<ReportConclusionReasonCode>(
  REPORT_CONCLUSION_REASON_CODES.filter(
    (reason) => reason !== 'ACTIVE_RISK_PRESENT' && reason !== 'LEGACY_SNAPSHOT_MISSING',
  ),
);

function orderedReasons(
  reasons: Iterable<ReportConclusionReasonCode>,
): ReportConclusionReasonCode[] {
  return [...new Set(reasons)].sort(
    (a, b) =>
      (REASON_ORDER.get(a) ?? Number.MAX_SAFE_INTEGER) -
      (REASON_ORDER.get(b) ?? Number.MAX_SAFE_INTEGER),
  );
}

function nonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

function scopedResults(
  results: readonly ReportConclusionResultInput[],
): ReportConclusionResultInput[] {
  return selectPrimaryReportResults(results);
}

export function buildReportConclusionSnapshot(
  input: ReportConclusionBuildInput,
): DeterministicReportConclusionSnapshot {
  const activeRiskCount = nonnegativeInteger(input.activeRiskCount, 'activeRiskCount');
  const resultDetailsAvailable = input.results !== undefined;
  const results = scopedResults(input.results ?? []);
  const engineRuns = input.engineRuns ?? [];
  const reasons = new Set<ReportConclusionReasonCode>();

  if (activeRiskCount > 0) reasons.add('ACTIVE_RISK_PRESENT');
  const taskCompleted = input.task
    ? input.task.status === 'COMPLETED'
    : input.scopeKind === 'TASK'
      ? false
      : null;
  if (taskCompleted === false) reasons.add('TASK_NOT_COMPLETED');

  let expected: number;
  if (input.scopeKind === 'TASK') {
    expected = nonnegativeInteger(input.task?.totalQuestions ?? 0, 'task.totalQuestions');
  } else {
    expected = results.length;
  }

  if (
    (input.scopeKind === 'TASK' && expected === 0) ||
    (input.scopeKind === 'RESULT_SET' && expected === 0)
  ) {
    reasons.add('EMPTY_SCOPE');
  }
  if (!resultDetailsAvailable) reasons.add('RESULT_DETAILS_UNAVAILABLE');

  const observed = results.length;
  let pass = 0;
  let fail = 0;
  let error = 0;
  let unknown = 0;
  let missingVerdict = 0;
  let modelCallError = 0;
  for (const result of results) {
    if (result.finalVerdict === 'PASS') pass += 1;
    else if (result.finalVerdict === 'FAIL') fail += 1;
    else if (result.finalVerdict === 'ERROR') error += 1;
    else if (result.finalVerdict === 'UNKNOWN') unknown += 1;
    else missingVerdict += 1;
    if (result.status === 'ERROR') modelCallError += 1;
  }
  const valid = pass + fail;
  const failDisposition = input.failDisposition ?? {
    activeFailCount: 0,
    excludedFailCount: 0,
    unexplainedFailCount: fail,
  };
  const activeFailCount = nonnegativeInteger(
    failDisposition.activeFailCount,
    'failDisposition.activeFailCount',
  );
  const excludedFailCount = nonnegativeInteger(
    failDisposition.excludedFailCount,
    'failDisposition.excludedFailCount',
  );
  const unexplainedFailCount = nonnegativeInteger(
    failDisposition.unexplainedFailCount,
    'failDisposition.unexplainedFailCount',
  );
  if (activeFailCount + excludedFailCount + unexplainedFailCount !== fail) {
    throw new TypeError('failDisposition must cover every FAIL result exactly once');
  }
  if (activeFailCount > 0 && activeRiskCount === 0) {
    throw new TypeError('active FAIL results require active risk evidence');
  }
  if (unexplainedFailCount > 0) {
    reasons.add('UNEXPLAINED_FAIL_RESULT');
  }

  let taskCountersMatch: boolean | null = null;
  if (input.scopeKind === 'TASK' && observed !== expected) {
    reasons.add('RESULT_COUNT_MISMATCH');
  }
  if (input.scopeKind === 'TASK' && input.task && resultDetailsAvailable) {
    taskCountersMatch =
      input.task.processedQuestions === observed &&
      input.task.passedCount === pass &&
      input.task.failedCount === fail &&
      input.task.errorCount === error;
    if (!taskCountersMatch) reasons.add('TASK_COUNTER_MISMATCH');
  }
  if (input.scopeKind !== 'ENGINE_RUN_SET' && observed > 0 && valid === 0) {
    reasons.add('NO_VALID_DECISION');
  }
  if (error > 0 || modelCallError > 0) reasons.add('RESULT_EXECUTION_ERROR');
  if (unknown > 0) reasons.add('RESULT_UNKNOWN');
  if (missingVerdict > 0) reasons.add('RESULT_VERDICT_MISSING');

  const engineRunFailed = engineRuns.filter((run) =>
    ['FAILED', 'ERROR'].includes(run.status),
  ).length;
  const engineRunSkipped = engineRuns.filter((run) => run.status === 'SKIPPED').length;
  const engineRunNonterminal = engineRuns.filter((run) =>
    ['PENDING', 'RUNNING'].includes(run.status),
  ).length;
  const engineRunPartialSkip = engineRuns.filter(
    (run) => nonnegativeInteger(run.skippedCount, 'engineRun.skippedCount') > 0,
  ).length;
  const skippedEvaluation = engineRuns.reduce(
    (sum, run) => sum + nonnegativeInteger(run.skippedCount, 'engineRun.skippedCount'),
    0,
  );

  let missingEngineRunCount = 0;
  if (input.scopeKind === 'TASK') {
    const expectedEngines = new Set(input.task?.expectedEngines ?? input.task?.engines ?? []);
    const observedEngines = new Set(engineRuns.flatMap((run) => (run.engine ? [run.engine] : [])));
    missingEngineRunCount = [...expectedEngines].filter(
      (engine) => !observedEngines.has(engine),
    ).length;
  } else if (input.scopeKind === 'ENGINE_RUN_SET' && engineRuns.length === 0) {
    missingEngineRunCount = 1;
  }
  if (missingEngineRunCount > 0) reasons.add('ENGINE_RUN_MISSING');
  if (engineRunNonterminal > 0) reasons.add('ENGINE_RUN_NOT_TERMINAL');
  if (engineRunFailed > 0) reasons.add('ENGINE_RUN_FAILED');
  if (engineRunSkipped > 0) reasons.add('ENGINE_RUN_SKIPPED');
  if (engineRunPartialSkip > 0) reasons.add('ENGINE_RUN_PARTIAL_SKIP');

  const reasonCodes = orderedReasons(reasons);
  const coverageComplete = !reasonCodes.some((reason) => COVERAGE_REASON_CODES.has(reason));
  const state: ReportConclusionState =
    activeRiskCount > 0 ? 'RISK_DETECTED' : coverageComplete ? 'NO_RISK_OBSERVED' : 'INCOMPLETE';
  const counts: ReportConclusionCounts = {
    expected,
    observed,
    valid,
    pass,
    fail,
    activeFailCount,
    excludedFailCount,
    unexplainedFailCount,
    error,
    unknown,
    missingVerdict,
    modelCallError,
    engineRunTotal: engineRuns.length,
    engineRunFailed,
    engineRunSkipped,
    engineRunNonterminal,
    engineRunPartialSkip,
    skippedEvaluation,
    unobservedResult: Math.max(expected - observed, 0),
  };

  return {
    schemaVersion: REPORT_CONCLUSION_SCHEMA_VERSION,
    policyVersion: REPORT_CONCLUSION_POLICY_VERSION,
    source: 'DETERMINISTIC_RULE',
    scopeKind: input.scopeKind,
    taskCompleted,
    resultDetailsAvailable,
    taskCountersMatch,
    missingEngineRunCount,
    state,
    coverageComplete,
    reasonCodes,
    basis: 'ACTIVE_RISK_AND_EXECUTION_COVERAGE',
    activeRiskCount,
    counts,
    passRate: ratio(pass, valid),
    validDecisionRate: observed > expected ? null : ratio(valid, expected),
  };
}

export function legacyReportConclusionSnapshot(
  scopeKind: ReportConclusionScopeKind = 'TASK',
): LegacyReportConclusionSnapshot {
  return {
    schemaVersion: REPORT_CONCLUSION_SCHEMA_VERSION,
    policyVersion: REPORT_CONCLUSION_POLICY_VERSION,
    source: 'LEGACY_FALLBACK',
    scopeKind,
    taskCompleted: null,
    resultDetailsAvailable: false,
    taskCountersMatch: null,
    missingEngineRunCount: 0,
    state: 'INCOMPLETE',
    coverageComplete: false,
    reasonCodes: ['LEGACY_SNAPSHOT_MISSING'],
    basis: null,
    activeRiskCount: null,
    counts: null,
    passRate: null,
    validDecisionRate: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new TypeError('report conclusion snapshot contains unknown or missing fields');
  }
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TypeError(`invalid ${label}`);
  }
  return value as T;
}

function parseCount(value: unknown, label: string): number {
  if (typeof value !== 'number') throw new TypeError(`invalid ${label}`);
  return nonnegativeInteger(value, label);
}

function parseNullableBoolean(value: unknown, label: string): boolean | null {
  if (value === null) return null;
  if (typeof value !== 'boolean') throw new TypeError(`invalid ${label}`);
  return value;
}

function parseRate(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`invalid ${label}`);
  }
  return value;
}

function equalRate(actual: number | null, expected: number | null): boolean {
  if (actual === null || expected === null) return actual === expected;
  return Math.abs(actual - expected) <= Number.EPSILON * 8;
}

const SNAPSHOT_KEYS = [
  'schemaVersion',
  'policyVersion',
  'source',
  'scopeKind',
  'taskCompleted',
  'resultDetailsAvailable',
  'taskCountersMatch',
  'missingEngineRunCount',
  'state',
  'coverageComplete',
  'reasonCodes',
  'basis',
  'activeRiskCount',
  'counts',
  'passRate',
  'validDecisionRate',
] as const;
const COUNT_KEYS = [
  'expected',
  'observed',
  'valid',
  'pass',
  'fail',
  'activeFailCount',
  'excludedFailCount',
  'unexplainedFailCount',
  'error',
  'unknown',
  'missingVerdict',
  'modelCallError',
  'engineRunTotal',
  'engineRunFailed',
  'engineRunSkipped',
  'engineRunNonterminal',
  'engineRunPartialSkip',
  'skippedEvaluation',
  'unobservedResult',
] as const;

export function parseReportConclusionSnapshot(value: unknown): ReportConclusionSnapshot {
  if (!isRecord(value)) throw new TypeError('report conclusion snapshot must be an object');
  assertExactKeys(value, SNAPSHOT_KEYS);
  if (value.schemaVersion !== REPORT_CONCLUSION_SCHEMA_VERSION) {
    throw new TypeError('unsupported report conclusion schemaVersion');
  }
  if (value.policyVersion !== REPORT_CONCLUSION_POLICY_VERSION) {
    throw new TypeError('unsupported report conclusion policyVersion');
  }
  const scopeKind = parseEnum(value.scopeKind, REPORT_CONCLUSION_SCOPE_KINDS, 'scopeKind');

  if (value.source === 'LEGACY_FALLBACK') {
    const fallback = legacyReportConclusionSnapshot(scopeKind);
    if (
      value.taskCompleted !== fallback.taskCompleted ||
      value.resultDetailsAvailable !== fallback.resultDetailsAvailable ||
      value.taskCountersMatch !== fallback.taskCountersMatch ||
      value.missingEngineRunCount !== fallback.missingEngineRunCount ||
      value.state !== fallback.state ||
      value.coverageComplete !== fallback.coverageComplete ||
      value.basis !== null ||
      value.activeRiskCount !== null ||
      value.counts !== null ||
      value.passRate !== null ||
      value.validDecisionRate !== null ||
      !Array.isArray(value.reasonCodes) ||
      value.reasonCodes.length !== 1 ||
      value.reasonCodes[0] !== 'LEGACY_SNAPSHOT_MISSING'
    ) {
      throw new TypeError('invalid legacy report conclusion snapshot');
    }
    return fallback;
  }
  if (value.source !== 'DETERMINISTIC_RULE') throw new TypeError('invalid source');
  if (value.basis !== 'ACTIVE_RISK_AND_EXECUTION_COVERAGE') throw new TypeError('invalid basis');

  const state = parseEnum(value.state, REPORT_CONCLUSION_STATES, 'state');
  if (typeof value.coverageComplete !== 'boolean') throw new TypeError('invalid coverageComplete');
  if (!Array.isArray(value.reasonCodes)) throw new TypeError('invalid reasonCodes');
  const reasonCodes = value.reasonCodes.map((reason) =>
    parseEnum(reason, REPORT_CONCLUSION_REASON_CODES, 'reasonCode'),
  );
  if (
    reasonCodes.includes('LEGACY_SNAPSHOT_MISSING') ||
    JSON.stringify(reasonCodes) !== JSON.stringify(orderedReasons(reasonCodes))
  ) {
    throw new TypeError('reasonCodes must be unique and canonically ordered');
  }

  const taskCompleted = parseNullableBoolean(value.taskCompleted, 'taskCompleted');
  if (typeof value.resultDetailsAvailable !== 'boolean') {
    throw new TypeError('invalid resultDetailsAvailable');
  }
  const resultDetailsAvailable = value.resultDetailsAvailable;
  const taskCountersMatch = parseNullableBoolean(value.taskCountersMatch, 'taskCountersMatch');
  const missingEngineRunCount = parseCount(value.missingEngineRunCount, 'missingEngineRunCount');
  const activeRiskCount = parseCount(value.activeRiskCount, 'activeRiskCount');
  if (!isRecord(value.counts)) throw new TypeError('invalid counts');
  const rawCounts = value.counts;
  assertExactKeys(rawCounts, COUNT_KEYS);
  const counts = Object.fromEntries(
    COUNT_KEYS.map((key) => [key, parseCount(rawCounts[key], `counts.${key}`)]),
  ) as unknown as ReportConclusionCounts;
  if (
    counts.valid !== counts.pass + counts.fail ||
    counts.activeFailCount + counts.excludedFailCount + counts.unexplainedFailCount !==
      counts.fail ||
    (counts.activeFailCount > 0 && activeRiskCount === 0) ||
    counts.observed !==
      counts.pass + counts.fail + counts.error + counts.unknown + counts.missingVerdict ||
    counts.modelCallError > counts.observed ||
    counts.unobservedResult !== Math.max(counts.expected - counts.observed, 0) ||
    counts.engineRunFailed + counts.engineRunSkipped + counts.engineRunNonterminal >
      counts.engineRunTotal ||
    counts.engineRunPartialSkip > counts.engineRunTotal ||
    (counts.engineRunPartialSkip === 0) !== (counts.skippedEvaluation === 0) ||
    counts.skippedEvaluation < counts.engineRunPartialSkip
  ) {
    throw new TypeError('inconsistent report conclusion counts');
  }
  if (
    (scopeKind === 'TASK' && taskCompleted === null) ||
    (scopeKind === 'TASK' &&
      taskCompleted === true &&
      resultDetailsAvailable &&
      taskCountersMatch === null) ||
    (scopeKind !== 'TASK' &&
      (counts.expected !== counts.observed || counts.unobservedResult !== 0)) ||
    (scopeKind !== 'TASK' && taskCountersMatch !== null) ||
    (!resultDetailsAvailable && taskCountersMatch !== null) ||
    (scopeKind === 'RESULT_SET' && missingEngineRunCount !== 0) ||
    (scopeKind === 'ENGINE_RUN_SET' &&
      ((counts.engineRunTotal === 0 && missingEngineRunCount !== 1) ||
        (counts.engineRunTotal > 0 && missingEngineRunCount !== 0)))
  ) {
    throw new TypeError('inconsistent report conclusion coverage signals');
  }

  const verifiableReasons: Array<[ReportConclusionReasonCode, boolean]> = [
    ['ACTIVE_RISK_PRESENT', activeRiskCount > 0],
    ['UNEXPLAINED_FAIL_RESULT', counts.unexplainedFailCount > 0],
    ['TASK_NOT_COMPLETED', taskCompleted === false],
    ['EMPTY_SCOPE', (scopeKind === 'TASK' || scopeKind === 'RESULT_SET') && counts.expected === 0],
    ['RESULT_DETAILS_UNAVAILABLE', !resultDetailsAvailable],
    ['RESULT_COUNT_MISMATCH', scopeKind === 'TASK' && counts.observed !== counts.expected],
    ['TASK_COUNTER_MISMATCH', taskCountersMatch === false],
    [
      'NO_VALID_DECISION',
      scopeKind !== 'ENGINE_RUN_SET' && counts.observed > 0 && counts.valid === 0,
    ],
    ['RESULT_EXECUTION_ERROR', counts.error > 0 || counts.modelCallError > 0],
    ['RESULT_UNKNOWN', counts.unknown > 0],
    ['RESULT_VERDICT_MISSING', counts.missingVerdict > 0],
    ['ENGINE_RUN_NOT_TERMINAL', counts.engineRunNonterminal > 0],
    ['ENGINE_RUN_FAILED', counts.engineRunFailed > 0],
    ['ENGINE_RUN_SKIPPED', counts.engineRunSkipped > 0],
    ['ENGINE_RUN_PARTIAL_SKIP', counts.engineRunPartialSkip > 0],
    ['ENGINE_RUN_MISSING', missingEngineRunCount > 0],
  ];
  for (const [reason, required] of verifiableReasons) {
    if (reasonCodes.includes(reason) !== required) {
      throw new TypeError(`report conclusion reason ${reason} is inconsistent with evidence`);
    }
  }

  const passRate = parseRate(value.passRate, 'passRate');
  const validDecisionRate = parseRate(value.validDecisionRate, 'validDecisionRate');
  if (
    !equalRate(passRate, ratio(counts.pass, counts.valid)) ||
    !equalRate(
      validDecisionRate,
      counts.observed > counts.expected ? null : ratio(counts.valid, counts.expected),
    )
  ) {
    throw new TypeError('inconsistent report conclusion rates');
  }

  const derivedCoverage = !reasonCodes.some((reason) => COVERAGE_REASON_CODES.has(reason));
  const derivedState: ReportConclusionState =
    activeRiskCount > 0 ? 'RISK_DETECTED' : derivedCoverage ? 'NO_RISK_OBSERVED' : 'INCOMPLETE';
  if (value.coverageComplete !== derivedCoverage || state !== derivedState) {
    throw new TypeError('report conclusion state is inconsistent with its evidence');
  }

  return {
    schemaVersion: REPORT_CONCLUSION_SCHEMA_VERSION,
    policyVersion: REPORT_CONCLUSION_POLICY_VERSION,
    source: 'DETERMINISTIC_RULE',
    scopeKind,
    taskCompleted,
    resultDetailsAvailable,
    taskCountersMatch,
    missingEngineRunCount,
    state,
    coverageComplete: value.coverageComplete,
    reasonCodes,
    basis: 'ACTIVE_RISK_AND_EXECUTION_COVERAGE',
    activeRiskCount,
    counts,
    passRate,
    validDecisionRate,
  };
}

export function normalizeReportConclusionSnapshot(
  value: unknown,
  fallbackScopeKind: ReportConclusionScopeKind = 'TASK',
): ReportConclusionSnapshot {
  try {
    return parseReportConclusionSnapshot(value);
  } catch {
    return legacyReportConclusionSnapshot(fallbackScopeKind);
  }
}

const STATE_LABELS: Record<ReportConclusionState, string> = {
  RISK_DETECTED: '本次评估范围内标记风险，需结合复核状态确认',
  NO_RISK_OBSERVED: '本次评估范围内未观察到风险',
  INCOMPLETE: '评估结论不完整',
};

const REASON_LABELS: Record<ReportConclusionReasonCode, string> = {
  ACTIVE_RISK_PRESENT: '存在尚未排除的风险判定（复核状态另列）',
  UNEXPLAINED_FAIL_RESULT: '存在未通过结果但缺少有效风险或人工排除归因',
  TASK_NOT_COMPLETED: '评估任务未完成',
  EMPTY_SCOPE: '评估范围为空',
  RESULT_DETAILS_UNAVAILABLE: '结果明细不可用',
  RESULT_COUNT_MISMATCH: '结果数量与预期不一致',
  TASK_COUNTER_MISMATCH: '任务计数与结果明细不一致',
  NO_VALID_DECISION: '没有有效判定结果',
  RESULT_EXECUTION_ERROR: '存在执行错误结果',
  RESULT_UNKNOWN: '存在未判定结果',
  RESULT_VERDICT_MISSING: '存在缺失判定结果',
  ENGINE_RUN_MISSING: '缺少引擎运行记录',
  ENGINE_RUN_NOT_TERMINAL: '存在未结束的引擎运行',
  ENGINE_RUN_FAILED: '存在失败的引擎运行',
  ENGINE_RUN_SKIPPED: '存在跳过的引擎运行',
  ENGINE_RUN_PARTIAL_SKIP: '存在部分跳过的引擎运行',
  LEGACY_SNAPSHOT_MISSING: '历史报告缺少统一结论快照',
};

export function renderReportConclusionStateZh(snapshot: ReportConclusionSnapshot): string {
  return STATE_LABELS[snapshot.state];
}

export function renderReportConclusionReasonZh(reason: ReportConclusionReasonCode): string {
  return REASON_LABELS[reason];
}

export function renderReportConclusionReasonsZh(snapshot: ReportConclusionSnapshot): string[] {
  return snapshot.reasonCodes.map(renderReportConclusionReasonZh);
}
