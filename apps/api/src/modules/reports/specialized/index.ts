import { buildEndpointReport, isEndpointReportData } from './endpoint.js';
import type { ReportInputData } from '../report-builder.js';
import { buildReportRiskContext, type ReportRiskContext } from '../report-risk-context.js';
import { buildSafetyOverviewReport } from './safety-overview.js';
import { buildRefusalCapabilityReport } from './refusal-capability.js';
import { buildPromptInjectionResilienceReport } from './prompt-injection-resilience.js';
import { buildComponentVulnerabilityReport } from './component-vulnerability.js';
import { buildServiceAssuranceReport } from './service-assurance.js';
import { buildMultilingualCoverageReport } from './multilingual-coverage.js';
import { buildAgentToolAbuseReport } from './agent-tool-abuse.js';
import { buildUsabilityOverRefusalReport } from './usability-over-refusal.js';
import { buildComprehensiveReport } from './comprehensive.js';
import { REPORT_KINDS, type ReportKind, type SpecializedReport } from './types.js';

export {
  REPORT_KINDS,
  REPORT_KIND_LABELS,
  type ReportKind,
  type SpecializedReport,
} from './types.js';

export function buildSpecializedReport(
  kind: ReportKind,
  data: ReportInputData,
  context: ReportRiskContext = buildReportRiskContext(data),
): SpecializedReport {
  if (isEndpointReportData(data)) return buildEndpointReport(kind, data);
  switch (kind) {
    case 'comprehensive':
      return buildComprehensiveReport(data, {}, context);
    case 'safety_overview':
      return buildSafetyOverviewReport(data, undefined, context);
    case 'refusal_capability':
      return buildRefusalCapabilityReport(data, context);
    case 'prompt_injection_resilience':
      return buildPromptInjectionResilienceReport(data, context);
    case 'component_vulnerability':
      return buildComponentVulnerabilityReport(data, context);
    case 'service_assurance':
      return buildServiceAssuranceReport(data);
    case 'multilingual_coverage':
      return buildMultilingualCoverageReport(data, context);
    case 'agent_tool_abuse':
      return buildAgentToolAbuseReport(data, context);
    case 'usability_over_refusal':
      return buildUsabilityOverRefusalReport(data, context);
    case 'gbt45654_content':
      throw new Error('国标报告不经通用报告构建流程生成');
  }
}
