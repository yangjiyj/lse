// 自管终端测评任务完成后的结果入库钩子。
// 协议端点车道（fleet-agent）在 POST /agent/v1/eval-jobs/:id/result 落库后调用注册的回调；
// 入库复用 endpoint-evals/service.ts 的同一条路径（applyEndpointUpdateTx），与 AgentShield 回调一致。
import { prisma } from '../../db.js';
import { writeAudit } from '../../lib/audit.js';
import { syncFleetJobTaskTx } from './service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 读取 FleetEvalJob.result 并写入 EvalResult/Finding/EvalTask 状态。
 * jobId 可以是内部 UUID（FleetEvalJob.id）或下发给采集器的 publicId（lej_…）。
 * 幂等：评估任务已是终态时 applyEndpointUpdateTx 直接返回，不会重复写结果。
 */
export async function finalizeFleetJob(jobId: string): Promise<void> {
  const job = await prisma.fleetEvalJob.findFirst({
    where: UUID_RE.test(jobId) ? { id: jobId } : { publicId: jobId },
  });
  if (!job) throw new Error(`自管终端测评任务不存在：${jobId}`);
  if (!job.evalTaskId) return;
  await prisma.$transaction((tx) => syncFleetJobTaskTx(tx, job), { timeout: 30_000 });
  if (job.status === 'COMPLETED' || job.status === 'FAILED')
    await writeAudit({
      action: 'fleet.eval_job.finalize',
      targetType: 'eval_task',
      targetId: job.evalTaskId,
      detail: { jobId: job.publicId, status: job.status, errorCode: job.errorCode },
    });
}

/**
 * 由 app 启动处把协议端点车道导出的 registerFleetJobFinishedHook 传进来：
 *   installFleetFinishHook(registerFleetJobFinishedHook)
 * 合并前不在任何地方调用。
 */
export function installFleetFinishHook(
  register: (fn: (jobId: string) => Promise<void>) => void,
): void {
  register(finalizeFleetJob);
}
