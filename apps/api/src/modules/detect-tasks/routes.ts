import type { FastifyInstance } from 'fastify';
import {
  canReadDetectRecord,
  DETECT_CATEGORIES,
  DETECT_RECORD_KIND_LABELS,
  DETECT_RECORD_KINDS,
  DETECT_TASK_STATUSES,
  detectRecordHref,
  type DetectRecordKind,
} from '@lse/shared';
import { z } from 'zod';
import { tenantFilterWhere } from '../../lib/all-tenants.js';
import { writeAudit } from '../../lib/audit.js';
import type { CurrentUser } from '../../lib/rbac.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { detectJobRuntime } from '../detect-jobs/orchestrator.js';
import {
  allowedActions,
  applyRecordAction,
  DETECT_RECORD_ACTIONS,
  evalTaskActionFlags,
} from '../detect-jobs/record-actions.js';
import { detectTaskStats, queryDetectTasks, type DetectTaskFilter } from './union-sql.js';

// 检测任务总览 /api/detect-tasks（2.4.1、2.4.4）：各类检测记录汇总统计、按四类筛选、下钻，
// 以及对单条记录暂停、恢复、停止。只汇总当前用户有查看权限的记录类型。

const READ = { preHandler: [requirePermission('detect_task:read')] };
const KINDS = Object.keys(DETECT_RECORD_KINDS) as [DetectRecordKind, ...DetectRecordKind[]];

const filterFields = {
  category: z.enum(DETECT_CATEGORIES).optional(),
  createdFrom: z.coerce.date().optional(),
  createdTo: z.coerce.date().optional(),
};
// 统计接受类型筛选（状态数和列表对得上）；不按类别筛，页面的四类统计要看全部类别。
const statsQuery = z.object({ ...filterFields, kind: z.enum(KINDS).optional() });
const listQuery = z.object({
  ...filterFields,
  kind: z.enum(KINDS).optional(),
  status: z.enum(DETECT_TASK_STATUSES).optional(),
  q: z.string().trim().max(200).optional(),
  jobId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
const actionParams = z.object({
  kind: z.enum(KINDS),
  id: z.string().uuid(),
  action: z.enum(DETECT_RECORD_ACTIONS),
});

function visibleKinds(user: CurrentUser): DetectRecordKind[] {
  return KINDS.filter((k) => canReadDetectRecord(k, (code) => user.permissions.has(code)));
}

export async function detectTaskRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get('/stats', READ, async (req) => {
    const q = statsQuery.parse(req.query);
    const filter: DetectTaskFilter = {
      ...q,
      kinds: visibleKinds(req.currentUser!),
      tenantId: tenantFilterWhere(req).tenantId,
    };
    return detectTaskStats(filter);
  });

  app.get('/', READ, async (req) => {
    const { page, pageSize, q, ...rest } = listQuery.parse(req.query);
    const filter: DetectTaskFilter = {
      ...rest,
      q: q || undefined,
      kinds: visibleKinds(req.currentUser!),
      tenantId: tenantFilterWhere(req).tenantId,
    };
    const { rows, total } = await queryDetectTasks(filter, page, pageSize);
    const evalIds = rows.filter((r) => r.kind === 'eval_task').map((r) => r.id);
    const flags = await evalTaskActionFlags(evalIds);
    const user = req.currentUser!;
    return {
      items: rows.map((r) => ({
        tenantId: r.tenant_id,
        kind: r.kind,
        kindLabel: DETECT_RECORD_KIND_LABELS[r.kind],
        category: r.category,
        id: r.id,
        name: r.name,
        status: r.status,
        rawStatus: r.raw_status,
        createdAt: r.created_at.toISOString(),
        startedAt: r.started_at?.toISOString() ?? null,
        finishedAt: r.finished_at?.toISOString() ?? null,
        createdBy:
          r.created_by_id && r.created_by_username
            ? { id: r.created_by_id, username: r.created_by_username }
            : null,
        href: detectRecordHref(r.kind, r.id),
        job: r.job_id ? { id: r.job_id, name: r.job_name ?? '' } : null,
        // 暂停中：已请求暂停、执行器还没停下。
        pauseRequested: flags.get(r.id)?.pauseRequested ?? false,
        // 只给当前用户有权限做的操作。
        actions: allowedActions(user, r.kind, r.status, {
          ...(flags.get(r.id) ?? { pausable: false }),
          createdById: r.created_by_id,
        }),
      })),
      total,
      page,
      pageSize,
    };
  });

  // 对单条记录暂停、恢复、停止：按记录类型和动作分别校验权限，不支持的 409。
  app.post('/:kind/:id/:action', READ, async (req) => {
    const { kind, id, action } = actionParams.parse(req.params);
    const user = req.currentUser!;
    const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null;
    const rt = detectJobRuntime();
    const result = await applyRecordAction(user, kind, id, action, {
      pauseEvalTask: rt.pauseEvalTask,
      cancelEvalTask: rt.cancelEvalTask,
      ip: req.ip,
      userAgent: ua,
    });
    await writeAudit({
      actorId: user.id,
      actorName: user.username,
      action: {
        pause: 'detect_task.pause',
        resume: 'detect_task.resume',
        stop: 'detect_task.stop',
      }[action],
      targetType: 'detect_task',
      targetId: id,
      ip: req.ip,
      userAgent: ua,
      detail: { kind, status: result.status },
    });
    return { kind, id, ...result };
  });
}
