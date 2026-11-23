import type {
  DetectCategory,
  DetectJobItemKind,
  DetectRecordKind,
  DetectTaskStatus,
} from '@lse/shared';
import { request } from '@/lib/api';

// 检测任务（2.4.1～2.4.4、2.4.9）：统一任务视图、组合任务、检测策略的前端类型与请求，
// 对应 apps/api/src/modules/detect-tasks 与 detect-jobs。

export type DetectRecordAction = 'pause' | 'resume' | 'stop';

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type StatusCounts = Record<DetectTaskStatus, number>;

export interface DetectTaskStats {
  total: number;
  byStatus: StatusCounts;
  byCategory: Record<DetectCategory, { total: number; byStatus: StatusCounts }>;
  byKind: Partial<Record<DetectRecordKind, number>>;
  /** 当前用户能看的记录类型 */
  kinds: DetectRecordKind[];
}

export interface DetectTaskRow {
  tenantId: string | null;
  kind: DetectRecordKind;
  kindLabel: string;
  category: DetectCategory;
  id: string;
  name: string;
  status: DetectTaskStatus;
  rawStatus: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdBy: { id: string; username: string } | null;
  href: string;
  job: { id: string; name: string } | null;
  /** 暂停中：已请求暂停、执行器还没停下 */
  pauseRequested: boolean;
  /** 当前用户有权限做的操作 */
  actions: DetectRecordAction[];
}

// 用 type 而不是 interface：要能当作请求的查询参数（带字符串索引）。
export type DetectTaskQuery = {
  category?: DetectCategory;
  kind?: DetectRecordKind;
  status?: DetectTaskStatus;
  q?: string;
  createdFrom?: string;
  createdTo?: string;
  jobId?: string;
  /** 全部租户视角下按租户筛 */
  tenantId?: string;
  page?: number;
  pageSize?: number;
};

export interface DetectJobItemInput {
  kind: DetectJobItemKind;
  title?: string;
  params: unknown;
  toolId?: string | null;
  ledgerAssetId?: string | null;
}

export interface DetectJobItemView {
  id: string;
  position: number;
  kind: string;
  kindLabel: string;
  category: DetectCategory | null;
  title: string;
  params: unknown;
  toolId: string | null;
  ledgerAssetId: string | null;
  status: DetectTaskStatus;
  error: string | null;
  /** 查看人没有该类记录的读权限：只显示类型和状态 */
  restricted?: boolean;
  recordKind: DetectRecordKind | null;
  recordId: string | null;
  recordName: string | null;
  href: string | null;
  actions: DetectRecordAction[];
  launchedAt: string | null;
  finishedAt: string | null;
}

export interface DetectJobView {
  id: string;
  name: string;
  status: DetectTaskStatus;
  maxParallel: number;
  strategyId: string | null;
  schemeId: string | null;
  triggeredBy: string;
  stopRequested: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  createdBy: { id: string; username: string } | null;
  itemCount: number;
  itemCounts: StatusCounts;
}

export interface DetectJobDetail extends DetectJobView {
  items: DetectJobItemView[];
}

export interface DetectStrategyView {
  id: string;
  name: string;
  description: string;
  items: DetectJobItemInput[];
  maxParallel: number;
  cron: string | null;
  timezone: string;
  enabled: boolean;
  minIntervalMinutes: number;
  lastTriggeredAt: string | null;
  lastSkipReason: string | null;
  nextRunAt: string | null;
  jobCount: number | null;
  createdBy: { id: string; username: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface DetectStrategyInput {
  name: string;
  description?: string;
  items: DetectJobItemInput[];
  maxParallel?: number;
  cron?: string | null;
  timezone?: string;
  enabled?: boolean;
  minIntervalMinutes?: number;
}

const id = (v: string) => encodeURIComponent(v);

export const detectTasksApi = {
  /** 统计不按类别筛（页面要看四类全部）；可按类型筛，状态数与列表对得上。 */
  stats(query: Pick<DetectTaskQuery, 'kind' | 'createdFrom' | 'createdTo' | 'tenantId'> = {}) {
    return request<DetectTaskStats>('GET', '/detect-tasks/stats', { query });
  },
  list(query: DetectTaskQuery = {}) {
    return request<Page<DetectTaskRow>>('GET', '/detect-tasks', { query });
  },
  action(kind: DetectRecordKind, recordId: string, action: DetectRecordAction) {
    return request<{
      kind: DetectRecordKind;
      id: string;
      status: DetectTaskStatus;
      pauseRequested?: boolean;
    }>('POST', `/detect-tasks/${id(kind)}/${id(recordId)}/${action}`);
  },
};

export const detectJobsApi = {
  list(
    query: {
      status?: DetectTaskStatus;
      strategyId?: string;
      page?: number;
      pageSize?: number;
    } = {},
  ) {
    return request<Page<DetectJobView>>('GET', '/detect-jobs', { query });
  },
  get(jobId: string) {
    return request<DetectJobDetail>('GET', `/detect-jobs/${id(jobId)}`);
  },
  create(body: {
    name: string;
    maxParallel?: number;
    items: DetectJobItemInput[];
    start?: boolean;
  }) {
    return request<DetectJobDetail>('POST', '/detect-jobs', { body });
  },
  lifecycle(jobId: string, action: 'start' | 'pause' | 'resume' | 'stop') {
    return request<DetectJobDetail>('POST', `/detect-jobs/${id(jobId)}/${action}`);
  },
  remove(jobId: string) {
    return request<{ id: string; deleted: true }>('DELETE', `/detect-jobs/${id(jobId)}`);
  },
  report(jobId: string, body: { title?: string; templateId?: string } = {}) {
    return request<{ id: string; title: string; kind: 'combined' }>(
      'POST',
      `/detect-jobs/${id(jobId)}/report`,
      { body },
    );
  },
};

export const detectStrategiesApi = {
  list(query: { page?: number; pageSize?: number } = {}) {
    return request<Page<DetectStrategyView>>('GET', '/detect-strategies', { query });
  },
  get(strategyId: string) {
    return request<DetectStrategyView>('GET', `/detect-strategies/${id(strategyId)}`);
  },
  create(body: DetectStrategyInput) {
    return request<DetectStrategyView>('POST', '/detect-strategies', { body });
  },
  update(strategyId: string, body: Partial<DetectStrategyInput>) {
    return request<DetectStrategyView>('PATCH', `/detect-strategies/${id(strategyId)}`, { body });
  },
  remove(strategyId: string) {
    return request<{ id: string; deleted: true }>('DELETE', `/detect-strategies/${id(strategyId)}`);
  },
  run(strategyId: string) {
    return request<DetectJobDetail>('POST', `/detect-strategies/${id(strategyId)}/run`);
  },
  jobs(strategyId: string, query: { page?: number; pageSize?: number } = {}) {
    return request<Page<DetectJobView>>('GET', `/detect-strategies/${id(strategyId)}/jobs`, {
      query,
    });
  },
};
