import type {
  ReportEngineRun,
  ReportEvalResult,
  ReportFinding,
  ReportInputData,
} from '../report-builder.js';
import type { ReportRiskPredicate, ReportRiskView } from '../report-risk-context.js';

export const AGENT_ENGINE = 'agent-tool-guard';
export const COMPONENT_ENGINE = 'ai-infra-guard';
const CONTENT_GLOBAL_ENGINES = new Set([
  'rule-judge',
  'sensitive-info',
  'llm-judge',
  'python-judge',
  'semantic-input-risk',
]);
const AGENT_GLOBAL_ENGINES = new Set([
  AGENT_ENGINE,
  'agent-llm-judge',
  'agent-fanout',
  'adr-sensor-import',
]);
const COMPONENT_GLOBAL_ENGINES = new Set([COMPONENT_ENGINE]);

const PROMPT_PATTERNS = [/prompt/i, /injection/i, /jailbreak/i, /注入/, /越狱/];
const REFUSAL_PATTERNS = [/should_refuse/i, /refusal/i, /拒答/];
const AGENT_PATTERNS = [
  /agent/i,
  /agent_runtime/i,
  /function call/i,
  /tool_calls?/i,
  /mcp/i,
  /工具调用/,
  /工具越权/,
  /越权代理/,
];
const COMPONENT_PATTERNS = [/component/i, /组件/i, /ai-infra/i, /openapi/i, /mcp/i];

function matches(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function resultText(result: ReportEvalResult): string {
  return [result.question.type, result.question.category ?? '', result.question.content].join(' ');
}

function findingText(finding: ReportFinding): string {
  return [finding.engine, finding.riskCategory, finding.title ?? ''].join(' ');
}

export function matchesPromptScope(text: string): boolean {
  return matches(text, PROMPT_PATTERNS);
}

export function matchesRefusalScope(text: string): boolean {
  return matches(text, REFUSAL_PATTERNS);
}

export function matchesAgentScope(text: string): boolean {
  return matches(text, AGENT_PATTERNS);
}

export function matchesComponentScope(text: string): boolean {
  return matches(text, COMPONENT_PATTERNS);
}

export function isPromptResult(result: ReportEvalResult): boolean {
  return matchesPromptScope(resultText(result));
}

export function isPromptFinding(finding: ReportFinding): boolean {
  return matchesPromptScope(findingText(finding));
}

export function isRefusalResult(result: ReportEvalResult): boolean {
  return (
    result.question.shouldRefuse ||
    result.question.type === 'SHOULD_REFUSE' ||
    matchesRefusalScope(resultText(result))
  );
}

export function isRefusalFinding(finding: ReportFinding): boolean {
  return matchesRefusalScope(findingText(finding));
}

export function isAgentResult(result: ReportEvalResult): boolean {
  return matchesAgentScope(resultText(result));
}

export function isAgentFinding(finding: ReportFinding): boolean {
  return finding.engine === AGENT_ENGINE || matchesAgentScope(findingText(finding));
}

export function isComponentResult(result: ReportEvalResult): boolean {
  return matchesComponentScope(resultText(result));
}

export function isComponentFinding(finding: ReportFinding): boolean {
  return finding.engine === COMPONENT_ENGINE || matchesComponentScope(findingText(finding));
}

export function hasAgentTrace(finding: ReportFinding): boolean {
  if (!finding.detail || typeof finding.detail !== 'object' || Array.isArray(finding.detail)) {
    return false;
  }
  const detail = finding.detail as Record<string, unknown>;
  return (
    (Array.isArray(detail.trace) && detail.trace.length > 0) ||
    (Array.isArray(detail.agentTrace) && detail.agentTrace.length > 0)
  );
}

function isAnySpecializedFinding(finding: ReportFinding): boolean {
  return (
    isPromptFinding(finding) ||
    isRefusalFinding(finding) ||
    isComponentFinding(finding) ||
    isAgentFinding(finding) ||
    hasAgentTrace(finding)
  );
}

export function scopedRiskPredicate(args: {
  findingMatches: (finding: ReportFinding) => boolean;
  resultMatches: (result: ReportEvalResult) => boolean;
}): ReportRiskPredicate {
  return (finding, risk) => {
    if (args.findingMatches(finding)) return true;

    // active 源风险只看有效证据是否已具备专项归属；纯 FP 源风险才看全部证据。
    // 这样“专项 FP + 通用有效证据”仍保留为有效风险，而其他专项证据不会串入。
    const scopeEvidence = risk.activeFindings.length > 0 ? risk.activeFindings : risk.findings;
    if (scopeEvidence.some(args.findingMatches)) return false;
    if (!risk.context.result || !args.resultMatches(risk.context.result)) return false;

    // 结果级兜底只允许真正通用的 Finding，避免把其他专项的 active 风险带入当前专项。
    return !isAnySpecializedFinding(finding);
  };
}

export function isUsabilityResult(result: ReportEvalResult): boolean {
  return result.question.type === 'GENERAL' && !result.question.shouldRefuse;
}

export function isMultilingualResult(result: ReportEvalResult): boolean {
  return Boolean(result.question.language);
}

export function questionSetScopeText(data: ReportInputData): string {
  return data.task.questionSets
    .map((set) => [set.name, set.type, set.language ?? ''].join(' '))
    .join(' ');
}

/** 平台智能体场景样本包标签（agent-evals/packs/platform-app*.ts 的 attackPackId）。 */
const PLATFORM_APP_PACK_RE = /^platform-app-v\d+$/;
/**
 * 平台智能体场景的 category 就是 AGENT_RISK_SURFACES 的取值（不带 agent: 前缀）。
 * 报告输入的 question 里没有 tags 和 metadata，只能靠这个白名单兜底判断。
 */
const AGENT_RISK_SURFACE_CATEGORIES = new Set([
  'ssrf',
  'secret_read',
  'file_read',
  'dangerous_command',
  'data_exfiltration',
  'indirect_prompt_injection',
  'tool_argument_bypass',
]);

export function isAgentRiskSurfaceCategory(category: string | null | undefined): boolean {
  return typeof category === 'string' && AGENT_RISK_SURFACE_CATEGORIES.has(category);
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** agent-tool-guard 引擎记录里的运行时信号：来自平台真实观测或 platform-app 样本包。 */
function engineRunPlatformSignal(run: ReportEngineRun): boolean {
  if (run.engine !== AGENT_ENGINE || !run.rawOutput) return false;
  try {
    const raw: unknown = JSON.parse(run.rawOutput);
    if (!isRecordValue(raw)) return false;
    if (raw.observed === true) return true;
    return typeof raw.attackPackId === 'string' && PLATFORM_APP_PACK_RE.test(raw.attackPackId);
  } catch {
    return false;
  }
}

/**
 * 纯平台智能体任务：只做智能体运行时测评，没有内容安全样本。
 * 条件：维度含 agent_tool_call，且每条结果都能确认是平台智能体场景。
 * 确认信号按可靠度依次取：该结果的 agent-tool-guard 引擎记录带平台观测/样本包标记；
 * 否则 category 落在 AGENT_RISK_SURFACES 白名单内（报告输入没有 tags 与 metadata，不能直接读 platform-app-v1 标签）。
 */
export function isPlatformAgentOnlyTask(data: ReportInputData): boolean {
  if (!(data.task.dimensions ?? []).includes('agent_tool_call')) return false;
  const results = data.results ?? [];
  if (results.length === 0) return false;
  const flaggedResultIds = new Set(
    data.engineRuns.filter(engineRunPlatformSignal).flatMap((run) => (run.resultId ? [run.resultId] : [])),
  );
  return results.every(
    (result) => (result.id !== undefined && flaggedResultIds.has(result.id)) || isAgentRiskSurfaceCategory(result.question.category),
  );
}

/**
 * 平台智能体任务的报告改写（场景明细、样本规模、去空占位）只用于评估对象为平台应用的任务：
 * 自研智能体（AGENT）任务同样不套内容评测专项，但它的工具轨迹来自评估沙箱模拟，措辞不同，不走这套改写。
 */
export function isPlatformAgentReport(data: ReportInputData): boolean {
  return data.task.modelTarget?.targetType === 'PLATFORM_APP' && isPlatformAgentOnlyTask(data);
}

function evidenceEngines(view: ReportRiskView): Set<string> {
  return new Set(
    [...view.risks, ...view.excludedRisks]
      .flatMap((risk) => risk.findings)
      .map((finding) => finding.engine),
  );
}

function engineRunsForScope(
  data: ReportInputData,
  view: ReportRiskView,
  results: readonly ReportEvalResult[],
  applicableGlobalEngines: ReadonlySet<string>,
): ReportEngineRun[] {
  const scopedResultIds = new Set(results.flatMap((result) => (result.id ? [result.id] : [])));
  const scopedEvidenceEngines = evidenceEngines(view);
  return data.engineRuns.filter((run) => {
    if (run.resultId) return scopedResultIds.has(run.resultId);
    return applicableGlobalEngines.has(run.engine) || scopedEvidenceEngines.has(run.engine);
  });
}

export function contentEngineRuns(
  data: ReportInputData,
  view: ReportRiskView,
  results: readonly ReportEvalResult[],
): ReportEngineRun[] {
  return engineRunsForScope(data, view, results, CONTENT_GLOBAL_ENGINES);
}

export function agentEngineRuns(
  data: ReportInputData,
  view: ReportRiskView,
  results: readonly ReportEvalResult[],
): ReportEngineRun[] {
  return engineRunsForScope(data, view, results, AGENT_GLOBAL_ENGINES);
}

export function componentEngineRuns(
  data: ReportInputData,
  view: ReportRiskView,
  results: readonly ReportEvalResult[],
): ReportEngineRun[] {
  return engineRunsForScope(data, view, results, COMPONENT_GLOBAL_ENGINES);
}
