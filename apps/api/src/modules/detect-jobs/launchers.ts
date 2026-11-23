import { DETECT_JOB_ITEM_META, type DetectJobItemKind, type DetectRecordKind } from '@lse/shared';
import type { CurrentUser } from '../../lib/rbac.js';
import { startAssetDiscoveryRun } from '../asset-discovery/launch.js';
import { rescanCorpus } from '../corpus-scans/rescan.js';
import { createEvalTaskFromTemplate } from '../eval-tasks/launch.js';
import { runEndpointPostureEval } from '../fleet-admin/posture-launch.js';
import { queueModelFileScan } from '../model-files/launch.js';
import type { DetectJobItemParams } from './item-params.js';

// 组合任务子任务的启动函数（2.4.9）：每类子任务建出原有的检测记录，各自按原队列执行。
// 都在调用者的租户范围内执行（API 请求里，或 worker 的 runInTenant 里）。

export interface LaunchContext {
  user: CurrentUser;
  ip: string | null;
  userAgent: string | null;
  source: 'detect_job';
}

export type Launcher<K extends DetectJobItemKind> = (
  params: DetectJobItemParams[K],
  ctx: LaunchContext & { title: string },
) => Promise<{ recordKind: DetectRecordKind; recordId: string }>;

export type Launchers = { [K in DetectJobItemKind]: Launcher<K> };

const audit = (ctx: LaunchContext) => ({ ip: ctx.ip, userAgent: ctx.userAgent });

export const DEFAULT_LAUNCHERS: Launchers = {
  eval_task: async ({ modelTargetId, ...template }, ctx) => {
    const { id } = await createEvalTaskFromTemplate(ctx.user, {
      name: ctx.title,
      modelTargetId,
      template,
      ...audit(ctx),
      source: ctx.source,
    });
    return { recordKind: DETECT_JOB_ITEM_META.eval_task.recordKind, recordId: id };
  },
  model_file_scan: async (p, ctx) => {
    const body = { targetId: p.targetId ?? null, datasetRefs: [] };
    const row = await queueModelFileScan(
      ctx.user,
      p.source === 'directory'
        ? { from: 'directory', path: p.path, body }
        : { from: 'library', uploadId: p.uploadId, body },
      audit(ctx),
    );
    return { recordKind: DETECT_JOB_ITEM_META.model_file_scan.recordKind, recordId: row.id };
  },
  corpus_scan: async (p, ctx) => {
    const scan = await rescanCorpus(ctx.user, p, audit(ctx));
    return { recordKind: DETECT_JOB_ITEM_META.corpus_scan.recordKind, recordId: scan.id };
  },
  asset_discovery: async (p, ctx) => {
    const run = await startAssetDiscoveryRun(
      ctx.user,
      { targets: p.targets, ports: p.ports },
      { ip: ctx.ip },
    );
    return { recordKind: DETECT_JOB_ITEM_META.asset_discovery.recordKind, recordId: run.id };
  },
  fleet_posture: async (p, ctx) => {
    const out = await runEndpointPostureEval(
      ctx.user,
      p.endpointId,
      { name: ctx.title, ...(p.items ? { items: p.items } : {}) },
      audit(ctx),
    );
    return { recordKind: DETECT_JOB_ITEM_META.fleet_posture.recordKind, recordId: out.taskId };
  },
};

/** 按类型调用启动函数（launchers 可部分替换，测试注入假实现）。 */
export function launchDetectJobItem<K extends DetectJobItemKind>(
  kind: K,
  params: DetectJobItemParams[K],
  ctx: LaunchContext & { title: string },
  launchers: Partial<Launchers> = {},
): Promise<{ recordKind: DetectRecordKind; recordId: string }> {
  const launcher = (launchers[kind] ?? DEFAULT_LAUNCHERS[kind]) as Launcher<K>;
  return launcher(params, ctx);
}
