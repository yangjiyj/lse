import type { Prisma } from '@prisma/client';
import { badRequest, notFound } from '../../lib/errors.js';
import { judgeProbeReport, mcpAllowlist } from '../fleet-admin/posture.js';
import { attachAgentSnapshot } from '../fleet-admin/agent-snapshot.js';
import { installAgents } from '../fleet-admin/inventory.js';
import {
  buildEndpointSummary,
  endpointHistoricalFindings,
  mergeEndpointEvidence,
  endpointIdentityReference,
  type EndpointTaskSummary,
} from './endpoint-summary.js';
const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(rec) : []);

/** 读取任务当时的配置报告和实际执行结果；不使用新的采集结果改写旧结论。 */
export async function loadEndpointSummary(
  db: Prisma.TransactionClient,
  taskId: string,
): Promise<EndpointTaskSummary> {
  const task = await db.evalTask.findUnique({
    where: { id: taskId },
    include: { modelTarget: true },
  });
  if (!task) throw notFound('评估任务不存在');
  if (
    task.modelTarget.targetType !== 'ENDPOINT_AGENT' &&
    !task.engines.includes('endpoint-agent-eval')
  )
    throw badRequest('该任务不是终端检测任务');
  const config = rec(task.modelTarget.accessConfig);
  const [results, findings, bindingLog, job, scenarioLogs, postureScope] = await Promise.all([
    db.evalResult.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
      include: { question: { select: { externalId: true } } },
    }),
    db.finding.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } }),
    db.evalTaskLog.findFirst({ where: { taskId, message: '终端测评任务绑定' } }),
    db.fleetEvalJob.findFirst({ where: { evalTaskId: taskId }, orderBy: { createdAt: 'desc' } }),
    db.evalTaskLog.findMany({
      where: { taskId, message: { in: ['终端场景判定', '终端诱饵接收'] } },
      orderBy: { createdAt: 'asc' },
      select: { message: true, context: true },
    }),
    db.evalTaskLog.findFirst({
      where: { taskId, message: '终端配置体检范围' },
      select: { context: true },
    }),
  ]);
  const creationAudit =
    !job && !findings.some((finding) => typeof rec(finding.detail).reportId === 'string')
      ? await db.auditLog.findFirst({
          where: {
            action: 'fleet.endpoint.posture_eval',
            targetType: 'eval_task',
            targetId: taskId,
          },
          orderBy: { createdAt: 'asc' },
          select: { detail: true },
        })
      : null;
  const reference = endpointIdentityReference(findings, job, config, creationAudit?.detail);
  let report = reference.reportId
    ? await db.fleetProbeReport.findUnique({ where: { reportId: reference.reportId } })
    : null;
  const endpointId = job?.endpointId || report?.endpointId || reference.endpointId;
  const endpoint = endpointId
    ? await db.fleetEndpoint.findUnique({ where: { id: endpointId } })
    : null;
  if (!report && !reference.reportId && endpoint && !bindingLog) {
    report = await db.fleetProbeReport.findFirst({
      where: { endpointId: endpoint.id, scannedAt: { lte: task.createdAt } },
      orderBy: { scannedAt: 'desc' },
    });
  }
  const rawAgents = attachAgentSnapshot(
    installAgents(report?.body).kept.map((a) => ({
      ...a,
      displayName: a.name,
      product: a.product || rec(a.evidence).product,
    })),
    // 新任务创建时已把配置读取状态存进体检范围日志；旧任务没有，读不到就不编造。
    rec(postureScope?.context).agents,
    report?.body,
  );
  const merged = mergeEndpointEvidence(results, findings);
  const summary = buildEndpointSummary({
    task,
    report: report?.body,
    endpoint: endpoint ?? { name: '历史终端信息暂不可用' },
    agents: rawAgents,
    // 登记状态是终端现在的能力，不随历史报告冻结；结论与证据仍取任务当时的数据。
    liveEval: rec(endpoint?.lastHealth).live_eval,
    findings: report
      ? endpointHistoricalFindings(
          judgeProbeReport(report.body, mcpAllowlist()).filter(
            (f) =>
              !Array.isArray(rec(postureScope?.context).items) ||
              (rec(postureScope?.context).items as unknown[]).includes(f.ruleId),
          ),
          merged,
        )
      : merged,
    results: merged,
    binding: bindingLog?.context,
    jobResult: job?.result,
    jobStatus: job?.status,
    jobStartedAt: job?.startedAt,
    scenarioLogs,
    sinkLogs: scenarioLogs.filter((log) => log.message === '终端诱饵接收'),
  });
  // 真机任务只列实际被测产品，不能把电脑上其他已装产品算作被测对象。
  if (bindingLog) {
    summary.mode = 'live';
    const product = rec(bindingLog.context).product;
    summary.agents = summary.agents.filter((a) => a.product === product);
  }
  return summary;
}
