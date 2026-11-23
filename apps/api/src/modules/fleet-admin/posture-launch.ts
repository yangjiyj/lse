import type { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { writeAudit } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { assertLicensedFeature } from '../../lib/license-enforcement.js';
import { createQuestions, ENDPOINT_ENGINE, json } from '../endpoint-evals/service.js';
import { agentSnapshot } from './agent-snapshot.js';
import { CHECK_CATALOG } from './check-catalog.js';
import { fleetAgentEnabled } from './config.js';
import { judgeProbeReport, mcpAllowlist } from './posture.js';
import { ensureFleetTarget } from './service.js';

// 终端配置体检的发起（终端页「发起体检」、组合任务的子任务、远程部署后的自动体检共用）。

const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export const lockEndpoint = (tx: Prisma.TransactionClient, id: string) =>
  tx.$queryRaw`SELECT id FROM fleet_endpoints WHERE id = ${id} FOR UPDATE`;

/** 终端和它最新一次体检上报；终端不存在 404，没有上报 409。 */
export async function latestReportOrConflict(endpointId: string) {
  const e = await prisma.fleetEndpoint.findUnique({ where: { id: endpointId } });
  if (!e) throw notFound('终端不存在');
  const report = await prisma.fleetProbeReport.findFirst({
    where: { endpointId },
    orderBy: { scannedAt: 'desc' },
  });
  if (!report)
    throw conflict(
      '该终端还没有上报配置体检数据，暂时无法体检。请确认采集器已按部署说明运行（可在终端执行一次 run --once），上报成功后再试。',
      'FLEET_NO_PROBE_REPORT',
    );
  return { endpoint: e, report };
}

/**
 * 按终端最新上报做一次配置体检，直接建出已完成的评估任务（不进队列）。
 * items 不给就是全部体检项。必须在租户范围内调用。审计 fleet.endpoint.posture_eval。
 */
export async function runEndpointPostureEval(
  user: { id: string; username: string },
  endpointId: string,
  input: { name?: string; items?: unknown },
  ctx: { ip: string | null; userAgent: string | null },
): Promise<{ taskId: string; status: 'COMPLETED'; reportScannedAt: string }> {
  if (!fleetAgentEnabled()) throw notFound('终端接入未启用');
  await assertLicensedFeature('web_ai');
  const requested = input.items;
  if (
    requested !== undefined &&
    (!Array.isArray(requested) ||
      requested.length === 0 ||
      requested.some(
        (item) =>
          typeof item !== 'string' || !CHECK_CATALOG.posture.some((check) => check.id === item),
      ))
  )
    throw badRequest('体检项不合法，请从检查目录中选择至少一项。');
  const { endpoint, report } = await latestReportOrConflict(endpointId);
  const selected = requested === undefined ? null : new Set(requested as string[]);
  const findings = judgeProbeReport(report.body, mcpAllowlist()).filter(
    (f) => !selected || selected.has(f.ruleId),
  );
  const task = await prisma.$transaction(
    async (tx) => {
      // 同一终端串行重算，避免并发点击在查重后各写入一份问题。
      await lockEndpoint(tx, endpoint.id);
      const target = await ensureFleetTarget(tx, endpoint, user.id);
      const existing = await tx.finding.findMany({
        where: {
          engine: ENDPOINT_ENGINE,
          task: { modelTargetId: target.id },
          remediationStatus: { notIn: ['VERIFIED_CLOSED', 'NOT_APPLICABLE'] },
          AND: [
            { detail: { path: ['reportId'], equals: report.reportId } },
            { detail: { path: ['endpointId'], equals: endpoint.publicId } },
          ],
        },
        select: { id: true, detail: true },
      });
      const reusable = new Set(existing.map((f) => rec(f.detail).ruleId));
      const now = new Date();
      const task = await tx.evalTask.create({
        data: {
          name: input.name ?? `${endpoint.hostname} 配置体检`,
          description: '终端配置体检完成',
          modelTargetId: target.id,
          createdById: user.id,
          engines: [ENDPOINT_ENGINE],
          dimensions: ['agent_tool_call'],
          status: 'COMPLETED',
          totalQuestions: findings.length,
          processedQuestions: findings.length,
          passedCount: findings.filter((f) => f.verdict === 'PASS').length,
          failedCount: findings.filter((f) => f.verdict === 'FAIL').length,
          progress: 100,
          startedAt: now,
          finishedAt: now,
        },
      });
      await tx.evalTaskLog.create({
        data: {
          taskId: task.id,
          level: 'info',
          message: '终端配置体检范围',
          context: json({
            endpointId: endpoint.id,
            reportId: report.reportId,
            items: findings.map((f) => f.ruleId),
            // 只存判断结果与安装位置，供任务页显示当时的真实配置读取状态。
            agents: agentSnapshot(report.body),
          }),
        },
      });
      const questions = await createQuestions(
        tx,
        task,
        findings.map((f) => ({ id: f.ruleId, title: f.title, prompt: f.title })),
      );
      for (const [index, finding] of findings.entries()) {
        const result = await tx.evalResult.create({
          data: {
            taskId: task.id,
            questionId: questions[index]!.id,
            modelTargetId: target.id,
            prompt: finding.title,
            response: finding.evidence,
            finalVerdict: finding.verdict,
          },
        });
        // 终端未上报该项(UNKNOWN)时没有可复核的结论：评估结果行保留，但不建 finding、不进待复核。
        if (finding.verdict !== 'PASS' && finding.verdict !== 'FAIL') continue;
        if (reusable.has(finding.ruleId)) continue;
        await tx.finding.create({
          data: {
            taskId: task.id,
            questionId: result.questionId,
            resultId: result.id,
            engine: ENDPOINT_ENGINE,
            title: finding.title,
            riskCategory: finding.riskCategory,
            severity: finding.severity,
            verdict: finding.verdict,
            evidence: finding.evidence,
            detail: json({
              ruleId: finding.ruleId,
              compliance: finding.compliance,
              collected_at: report.scannedAt.toISOString(),
              source: 'jiandun-fleet-probe-report',
              reportId: report.reportId,
              endpointId: endpoint.publicId,
            }),
          },
        });
      }
      return task;
    },
    { timeout: 30_000 },
  );
  await writeAudit({
    actorId: user.id,
    actorName: user.username,
    action: 'fleet.endpoint.posture_eval',
    targetType: 'eval_task',
    targetId: task.id,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    detail: { endpointId: endpoint.id, reportId: report.reportId },
  });
  return { taskId: task.id, status: 'COMPLETED', reportScannedAt: report.scannedAt.toISOString() };
}
