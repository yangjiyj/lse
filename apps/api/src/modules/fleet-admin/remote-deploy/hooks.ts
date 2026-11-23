import { prismaUnscoped } from '../../../db.js';
import { loadCurrentUser } from '../../../lib/rbac.js';
import { runInTenant } from '../../../lib/tenant-context.js';
import { PLATFORM_TENANT_ID } from '../../../lib/tenant-models.js';
import { runEndpointPostureEval } from '../posture-launch.js';

// 远程部署（2.4.8）的「回传结果」：终端第一次上报体检数据时记下时间，并按设置自动做一次配置体检。

/**
 * 体检上报入库成功后调用（终端接入协议里 void 调用，异常只记日志）。
 * 只处理该终端（按终端 id 或它登记用的接入码）还没收到过上报的部署记录；同一条记录只体检一次。
 */
export async function onProbeReportStored(endpointId: string): Promise<void> {
  const endpoint = await prismaUnscoped.fleetEndpoint.findUnique({
    where: { id: endpointId },
    select: { id: true, hostname: true, enrollmentCodeId: true, registeredAt: true },
  });
  if (!endpoint) return;
  const deploys = await prismaUnscoped.fleetRemoteDeploy.findMany({
    where: {
      firstReportAt: null,
      OR: [
        { endpointId },
        ...(endpoint.enrollmentCodeId ? [{ enrollmentCodeId: endpoint.enrollmentCodeId }] : []),
      ],
    },
  });
  for (const deploy of deploys) {
    // 领取：并发上报时只有一个能写上 firstReportAt。
    const claimed = await prismaUnscoped.fleetRemoteDeploy.updateMany({
      where: { id: deploy.id, firstReportAt: null },
      data: {
        firstReportAt: new Date(),
        endpointId,
        ...(deploy.registeredAt ? {} : { registeredAt: endpoint.registeredAt }),
        ...(deploy.mode === 'manual' && deploy.status === 'PENDING' ? { status: 'SUCCEEDED' } : {}),
        ...(deploy.mode === 'manual' && deploy.scriptFetchedAt && deploy.durationMs === null
          ? { durationMs: endpoint.registeredAt.getTime() - deploy.scriptFetchedAt.getTime() }
          : {}),
      },
    });
    if (claimed.count === 0 || !deploy.runPosture || !deploy.createdById) continue;
    const tenantId = deploy.tenantId ?? PLATFORM_TENANT_ID;
    const user = await loadCurrentUser(deploy.createdById);
    if (!user || !user.isActive) continue;
    const task = await runInTenant(tenantId, () =>
      runEndpointPostureEval(
        user,
        endpointId,
        { name: `${endpoint.hostname} 远程部署后配置体检`.slice(0, 200) },
        { ip: null, userAgent: null },
      ),
    );
    await prismaUnscoped.fleetRemoteDeploy.update({
      where: { id: deploy.id },
      data: { postureTaskId: task.taskId },
    });
  }
}
