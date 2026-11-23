/** 待办合并：同一任务的多条发现合并为一行，带计数与最高严重度，并按优先级排序。 */
const SEVERITY_RANK: Record<string, number> = {
  CRITICAL: 5,
  HIGH: 4,
  MEDIUM: 3,
  LOW: 2,
  INFO: 1,
};

export function severityRank(value: string | null | undefined): number {
  return value ? (SEVERITY_RANK[value] ?? 0) : 0;
}

export interface TaskTodoInput {
  id: string;
  tenantId?: string | null;
  taskId: string;
  taskName: string;
  title: string | null;
  severity: string | null;
  overdue?: boolean;
  dueAt?: string;
}

export interface MergedTaskTodo {
  taskId: string;
  tenantId?: string | null;
  taskName: string;
  count: number;
  topSeverity: string | null;
  overdueCount: number;
  /** 去重后的发现标题，按严重度从高到低。 */
  titles: string[];
  /** 最近到期时间（仅整改项）。 */
  earliestDue: string | null;
}

export function mergeTodosByTask(items: TaskTodoInput[]): MergedTaskTodo[] {
  const map = new Map<string, MergedTaskTodo & { _t: Array<[number, string]> }>();
  for (const item of items) {
    let g = map.get(item.taskId);
    if (!g) {
      g = {
        taskId: item.taskId,
        tenantId: item.tenantId ?? null,
        taskName: item.taskName,
        count: 0,
        topSeverity: null,
        overdueCount: 0,
        titles: [],
        earliestDue: null,
        _t: [],
      };
      map.set(item.taskId, g);
    }
    g.count += 1;
    if (severityRank(item.severity) > severityRank(g.topSeverity)) g.topSeverity = item.severity;
    if (item.overdue) g.overdueCount += 1;
    if (item.dueAt && (!g.earliestDue || item.dueAt < g.earliestDue)) g.earliestDue = item.dueAt;
    g._t.push([severityRank(item.severity), item.title ?? '风险发现']);
  }
  return [...map.values()]
    .map(({ _t, ...g }) => ({
      ...g,
      titles: [...new Set(_t.sort((a, b) => b[0] - a[0]).map((x) => x[1]))],
    }))
    .sort(
      (a, b) =>
        b.overdueCount - a.overdueCount ||
        severityRank(b.topSeverity) - severityRank(a.topSeverity) ||
        b.count - a.count,
    );
}

/** 后端按任务分组后的待复核行（count 是该任务真实待复核数）。 */
export interface ReviewTaskGroup {
  taskId: string;
  tenantId?: string | null;
  taskName: string;
  count: number;
  topSeverity: string | null;
  titles: string[];
}

/**
 * 待复核任务行：优先用后端按任务分组的结果（数量是真实数，不被截断）；
 * 老版本后端没有 tasks 字段时，回退到把最近若干条风险项按任务合并（此时数量只是已列出的条数）。
 */
export function reviewTaskRows(review: {
  items: TaskTodoInput[];
  tasks?: ReviewTaskGroup[];
}): ReviewTaskGroup[] {
  if (review.tasks) return review.tasks;
  return mergeTodosByTask(review.items).map((g) => ({
    taskId: g.taskId,
    tenantId: g.tenantId ?? null,
    taskName: g.taskName,
    count: g.count,
    topSeverity: g.topSeverity,
    titles: g.titles,
  }));
}
