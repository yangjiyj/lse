import type { ReportInputData } from '../report-builder.js';
import type { ReportRiskContext } from '../report-risk-context.js';
import {
  AGENT_ENGINE,
  COMPONENT_ENGINE,
  hasAgentTrace,
  isAgentFinding,
  isAgentResult,
  isComponentFinding,
  isComponentResult,
  isMultilingualResult,
  isPlatformAgentOnlyTask,
  isPromptFinding,
  isPromptResult,
  isRefusalFinding,
  isRefusalResult,
  isUsabilityResult,
  matchesAgentScope,
  matchesComponentScope,
  matchesPromptScope,
  matchesRefusalScope,
  questionSetScopeText,
} from './scope.js';
import type { ReportKind } from './types.js';

const AGENT_REPORT_KIND: ReportKind = 'agent_tool_abuse';
const COMPONENT_REPORT_KIND: ReportKind = 'component_vulnerability';

const CONTENT_SAFETY_DIMENSIONS = new Set([
  'content_safety',
  'content_compliance',
  'data_security',
  'sensitive_info',
  'privacy',
  'prompt_injection',
  'jailbreak',
  'should_refuse',
  'refusal',
  'multilingual',
  'forbidden_content',
]);

function addKind(kinds: ReportKind[], kind: ReportKind) {
  if (!kinds.includes(kind)) kinds.push(kind);
}

function fallbackFindings(data: ReportInputData, context?: ReportRiskContext) {
  return context?.portfolio.allFindings ?? data.findings;
}

export function hasAgentContent(data: ReportInputData, context?: ReportRiskContext) {
  if ((data.task.dimensions ?? []).includes('agent_tool_call')) return true;
  if (matchesAgentScope(questionSetScopeText(data))) return true;
  if ((data.results ?? []).some(isAgentResult)) return true;
  if (data.engineRuns.some((run) => run.engine === AGENT_ENGINE)) return true;
  return fallbackFindings(data, context).some(
    (finding) => isAgentFinding(finding) || hasAgentTrace(finding),
  );
}

function hasComponentContent(data: ReportInputData, context?: ReportRiskContext) {
  if ((data.task.dimensions ?? []).includes('component_vulnerability')) return true;
  if (matchesComponentScope(questionSetScopeText(data))) return true;
  if ((data.results ?? []).some(isComponentResult)) return true;
  if (data.engineRuns.some((run) => run.engine === COMPONENT_ENGINE)) return true;
  return fallbackFindings(data, context).some(isComponentFinding);
}

function hasRefusalScope(data: ReportInputData, context?: ReportRiskContext) {
  if ((data.task.dimensions ?? []).some(matchesRefusalScope)) return true;
  if (matchesRefusalScope(questionSetScopeText(data))) return true;
  if ((data.results ?? []).some(isRefusalResult)) return true;
  return fallbackFindings(data, context).some(isRefusalFinding);
}

function hasPromptScope(data: ReportInputData, context?: ReportRiskContext) {
  if ((data.task.dimensions ?? []).some(matchesPromptScope)) return true;
  if (matchesPromptScope(questionSetScopeText(data))) return true;
  if ((data.results ?? []).some(isPromptResult)) return true;
  return fallbackFindings(data, context).some(isPromptFinding);
}

function hasMultilingualScope(data: ReportInputData) {
  if ((data.task.dimensions ?? []).includes('multilingual')) return true;
  if (data.task.questionSets.some((set) => Boolean(set.language))) return true;
  return (data.results ?? []).some(isMultilingualResult);
}

function hasGeneralUsableQuestions(data: ReportInputData) {
  return (data.results ?? []).some(isUsabilityResult);
}

function hasContentSafetyContent(data: ReportInputData, hasSpecialSetSignal: boolean) {
  if ((data.task.dimensions ?? []).some((dimension) => CONTENT_SAFETY_DIMENSIONS.has(dimension))) {
    return true;
  }
  if ((data.results ?? []).some((result) => !matchesAgentScope(result.question.category ?? ''))) {
    return true;
  }
  if (data.task.questionSets.length > 0 && !hasSpecialSetSignal) return true;
  return (data.task.dimensions ?? []).length === 0 && data.task.questionSets.length === 0;
}

export function applicableReportKinds(
  data: ReportInputData,
  context?: ReportRiskContext,
): ReportKind[] {
  if (data.serviceAssurance) return ['service_assurance'];

  // 平台智能体任务（Dify/Coze 真实观测）：场景 category 不带 agent: 前缀，会被下面的
  // “非智能体类结果”规则误判成内容安全任务，于是套上拒答、提示注入、多语言专项。这里先行拦截。
  if (isPlatformAgentOnlyTask(data)) return [AGENT_REPORT_KIND, 'safety_overview'];

  const agent = hasAgentContent(data, context);
  const component = hasComponentContent(data, context);
  const content = hasContentSafetyContent(data, agent || component);

  if (agent && !content && !component) return [AGENT_REPORT_KIND, 'safety_overview'];
  if (component && !content && !agent) return [COMPONENT_REPORT_KIND, 'safety_overview'];

  const kinds: ReportKind[] = ['safety_overview'];
  if (content && hasRefusalScope(data, context)) addKind(kinds, 'refusal_capability');
  if (content && hasPromptScope(data, context)) addKind(kinds, 'prompt_injection_resilience');
  if (content && hasMultilingualScope(data)) addKind(kinds, 'multilingual_coverage');
  if (content && hasGeneralUsableQuestions(data)) addKind(kinds, 'usability_over_refusal');
  if (agent) addKind(kinds, AGENT_REPORT_KIND);
  if (component) addKind(kinds, COMPONENT_REPORT_KIND);
  return kinds;
}

export function isReportKindApplicable(
  kind: ReportKind,
  data: ReportInputData,
  context?: ReportRiskContext,
) {
  return applicableReportKinds(data, context).includes(kind);
}
