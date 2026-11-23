import type { TaskTargetLookup } from '../../lib/endpoint-task-policy.js';
import { assertNonEndpointTaskTargetId } from '../../lib/endpoint-task-policy.js';
import type { AssuranceDryRunResult } from './runner.js';

const ASSURANCE_TASK_NAME_PREFIX = '网关 Assurance 自动闭环';
const ASSURANCE_ENGINE = 'gateway-assurance';
const ASSURANCE_DIMENSIONS = [
  'gateway_recording',
  'content_security',
  'security_event',
  'alert_audit',
];

export interface AssuranceEvalTaskClient extends TaskTargetLookup {
  evalTask: {
    findFirst(args: any): Promise<{ id: string } | null>;
    create(args: any): Promise<{ id: string }>;
    update(args: any): Promise<{ id: string }>;
  };
  evalTaskQuestionSet: {
    upsert(args: any): Promise<unknown>;
  };
  evalTaskLog: {
    create(args: any): Promise<unknown>;
  };
}

export interface AssuranceEvalTaskWritebackInput {
  runId: string;
  modelTargetId: string;
  questionSetId: string;
  result: AssuranceDryRunResult;
  artifactManifestPath: string;
  gatewayRef: string;
  lseRef: string;
  now?: Date;
}

export interface AssuranceEvalTaskWritebackResult {
  evalTaskId: string;
  created: boolean;
  taskName: string;
}

export async function writeAssuranceRunToEvalTask(
  client: AssuranceEvalTaskClient,
  input: AssuranceEvalTaskWritebackInput,
): Promise<AssuranceEvalTaskWritebackResult> {
  await assertNonEndpointTaskTargetId(client, input.modelTargetId);
  const taskName = `${ASSURANCE_TASK_NAME_PREFIX} ${assuranceTaskDate(input.runId, input.now)}`;
  const summary = summarizeDryRun(input.result);
  const timestamp = input.now ?? new Date();
  const taskData = {
    name: taskName,
    description: taskDescription(input, summary),
    status: input.result.status === 'PAUSED' ? 'PAUSED' : 'COMPLETED',
    modelTargetId: input.modelTargetId,
    engines: [ASSURANCE_ENGINE],
    dimensions: ASSURANCE_DIMENSIONS,
    concurrency: 1,
    totalQuestions: summary.total,
    processedQuestions: summary.total,
    passedCount: summary.passed,
    failedCount: summary.failures,
    errorCount: input.result.status === 'COMPLETED' ? 0 : summary.total,
    progress: input.result.status === 'COMPLETED' ? 100 : 0,
    startedAt: timestamp,
    finishedAt: input.result.status === 'COMPLETED' ? timestamp : null,
  };

  const existing = await client.evalTask.findFirst({
    where: { name: taskName, modelTargetId: input.modelTargetId },
    select: { id: true },
  });

  const task = existing
    ? await client.evalTask.update({ where: { id: existing.id }, data: taskData })
    : await client.evalTask.create({ data: taskData });

  await client.evalTaskQuestionSet.upsert({
    where: {
      taskId_questionSetId: {
        taskId: task.id,
        questionSetId: input.questionSetId,
      },
    },
    create: {
      taskId: task.id,
      questionSetId: input.questionSetId,
    },
    update: {},
  });

  await client.evalTaskLog.create({
    data: {
      taskId: task.id,
      level: summary.failures > 0 ? 'warn' : 'info',
      message:
        summary.failures > 0
          ? `网关 Assurance 闭环发现 ${summary.failures} 个问题，样本 ${summary.total} 条，策略命中 ${summary.policyHitSamples}/${summary.total}。`
          : `网关 Assurance 闭环通过，样本 ${summary.total} 条，攻防探针 ${summary.attackDefenseCases} 条，策略命中 ${summary.policyHitSamples}/${Math.max(input.result.samples.length, 1)}。`,
      context: {
        runId: input.runId,
        artifactManifestPath: input.artifactManifestPath,
        gatewayRef: input.gatewayRef,
        lseRef: input.lseRef,
        total: summary.total,
        failures: summary.failures,
        failureCodes: summary.failureCodes,
        policyHitSamples: summary.policyHitSamples,
        policyHitTotal: summary.policyHitTotal,
        multiTurnSamples: summary.multiTurnSamples,
        ruleIds: summary.ruleIds,
        attackDefenseCases: summary.attackDefenseCases,
        attackDefenseBypassCount: summary.attackDefenseBypassCount,
        attackDefenseExecutionErrorCount: summary.attackDefenseExecutionErrorCount,
        attackDefenseWritebackMissingCount: summary.attackDefenseWritebackMissingCount,
      },
    },
  });

  return { evalTaskId: task.id, created: !existing, taskName };
}

function summarizeDryRun(result: AssuranceDryRunResult): {
  total: number;
  failures: number;
  passed: number;
  failureCodes: string[];
  policyHitSamples: number;
  policyHitTotal: number;
  multiTurnSamples: number;
  ruleIds: string[];
  attackDefenseCases: number;
  attackDefenseBypassCount: number;
  attackDefenseExecutionErrorCount: number;
  attackDefenseWritebackMissingCount: number;
} {
  const failureCodes = result.attributions.flatMap((item) => item.failureCodes);
  const failures = result.attributions.filter((item) => item.failureCodes.length > 0).length;
  const attackDefenseCases = result.attackDefense?.caseCount ?? 0;
  const total = result.samples.length + attackDefenseCases;
  const evidenceSummaries = result.evidenceSummaries ?? [];
  return {
    total,
    failures,
    passed: Math.max(total - failures, 0),
    failureCodes: [...new Set(failureCodes)],
    policyHitSamples: evidenceSummaries.filter((item) => item.policyHitCount > 0).length,
    policyHitTotal: evidenceSummaries.reduce((sum, item) => sum + item.policyHitCount, 0),
    multiTurnSamples: Math.max(
      result.samples.filter((sample) => (sample.turns?.length ?? 0) > 1).length,
      evidenceSummaries.filter((item) => item.variantId === 'multi_turn').length,
    ),
    ruleIds: [...new Set(evidenceSummaries.flatMap((item) => item.ruleIds))],
    attackDefenseCases,
    attackDefenseBypassCount: result.attackDefense?.bypassCount ?? 0,
    attackDefenseExecutionErrorCount: result.attackDefense?.executionErrorCount ?? 0,
    attackDefenseWritebackMissingCount: result.attackDefense?.gatewayWritebackMissingCount ?? 0,
  };
}

function taskDescription(
  input: AssuranceEvalTaskWritebackInput,
  summary: ReturnType<typeof summarizeDryRun>,
): string {
  return [
    '自动闭环对大模型安全网关发起保障样本，并核对网关请求记录、内容留存、安全事件、告警和可见性证据。',
    `最近运行：${input.runId}`,
    `样本：${summary.total} 条，通过 ${summary.passed} 条，风险 ${summary.failures} 条。`,
    `策略命中：${summary.policyHitSamples}/${Math.max(input.result.samples.length, 1)} 条样本有网关 policy_hits，多轮样本 ${summary.multiTurnSamples} 条。`,
    `攻防探针：${summary.attackDefenseCases} 条，边界突破 ${summary.attackDefenseBypassCount} 条，执行异常 ${summary.attackDefenseExecutionErrorCount} 条，回写缺失 ${summary.attackDefenseWritebackMissingCount} 条。`,
    `版本：gateway=${input.gatewayRef}，lse=${input.lseRef}。`,
    `产物：${input.artifactManifestPath}`,
  ].join('\n');
}

function assuranceTaskDate(runId: string, now = new Date()): string {
  const compact = runId.match(/(20\d{2})(\d{2})(\d{2})/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const dashed = runId.match(/(20\d{2})-(\d{2})-(\d{2})/);
  if (dashed) return `${dashed[1]}-${dashed[2]}-${dashed[3]}`;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now);
}
