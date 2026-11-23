import type { ReportInputData } from './report-builder.js';
import { summarizeForJudge, type ReportAiJudgment, type ReportJudgeInput } from './report-judge.js';
import { buildReportRiskContext, type ReportRiskContext } from './report-risk-context.js';
import { applicableReportKinds } from './specialized/applicability.js';
import type { ReportKind, SpecializedReport } from './specialized/types.js';

export interface ReportGenerationPlan {
  context: ReportRiskContext;
  judgeInput: ReportJudgeInput;
  allowedKinds: ReportKind[];
}

export interface ReportGenerationPlanDependencies {
  buildContext?: (data: ReportInputData) => ReportRiskContext;
  summarize?: (data: ReportInputData, context: ReportRiskContext) => ReportJudgeInput;
  applicableKinds?: (data: ReportInputData, context: ReportRiskContext) => ReportKind[];
}

export function buildReportGenerationPlan(
  data: ReportInputData,
  dependencies: ReportGenerationPlanDependencies = {},
): ReportGenerationPlan {
  const context = (dependencies.buildContext ?? buildReportRiskContext)(data);
  const judgeInput = (dependencies.summarize ?? summarizeForJudge)(data, context);
  const applicableKinds = (dependencies.applicableKinds ?? applicableReportKinds)(data, context);
  const allowedKinds = [
    'comprehensive' as const,
    ...applicableKinds.filter((kind) => kind !== 'comprehensive'),
  ];

  return {
    context,
    judgeInput,
    allowedKinds: [...new Set(allowedKinds)],
  };
}

export interface ReportGenerationExecutionDependencies extends ReportGenerationPlanDependencies {
  generateJudgment: (input: ReportJudgeInput) => Promise<ReportAiJudgment | undefined>;
  redactJudgment: (judgment: ReportAiJudgment) => ReportAiJudgment;
  buildReport: (
    kind: ReportKind,
    data: ReportInputData,
    context: ReportRiskContext,
  ) => SpecializedReport;
}

export interface ReportGenerationExecution {
  plan: ReportGenerationPlan;
  report: SpecializedReport | null;
}

function requiresOverallJudgment(kind: ReportKind): boolean {
  return kind === 'comprehensive' || kind === 'safety_overview';
}

export async function executeReportGenerationPlan(
  kind: ReportKind,
  deliveryData: ReportInputData,
  dependencies: ReportGenerationExecutionDependencies,
): Promise<ReportGenerationExecution> {
  const plan = buildReportGenerationPlan(deliveryData, dependencies);
  if (!plan.allowedKinds.includes(kind)) {
    return { plan, report: null };
  }

  if (requiresOverallJudgment(kind)) {
    const judgment = await dependencies.generateJudgment(plan.judgeInput);
    if (judgment) {
      // 只对不可信 judgment 做防御性脱敏，并原位挂载；不得克隆整份 deliveryData。
      deliveryData.aiJudgment = dependencies.redactJudgment(judgment);
    }
  }

  return {
    plan,
    report: dependencies.buildReport(kind, deliveryData, plan.context),
  };
}
