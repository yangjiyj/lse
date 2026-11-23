import { describe, expect, it } from 'vitest';
import { mergeTodosByTask, reviewTaskRows } from './todo-merge';

describe('mergeTodosByTask', () => {
  it('同一任务合并计数，取最高严重度，标题按严重度降序去重', () => {
    const r = mergeTodosByTask([
      { id: '1', taskId: 'a', taskName: 'A', title: '低项', severity: 'LOW' },
      { id: '2', taskId: 'a', taskName: 'A', title: '高项', severity: 'HIGH' },
      { id: '3', taskId: 'a', taskName: 'A', title: '高项', severity: 'HIGH' },
      { id: '4', taskId: 'b', taskName: 'B', title: null, severity: 'INFO' },
    ]);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ taskId: 'a', count: 3, topSeverity: 'HIGH' });
    expect(r[0]!.titles).toEqual(['高项', '低项']);
    expect(r[1]!.titles).toEqual(['风险发现']);
  });

  it('逾期项优先，其次严重度，再次数量', () => {
    const r = mergeTodosByTask([
      { id: '1', taskId: 'a', taskName: 'A', title: 'x', severity: 'CRITICAL', overdue: false },
      { id: '2', taskId: 'b', taskName: 'B', title: 'y', severity: 'LOW', overdue: true },
    ]);
    expect(r.map((x) => x.taskId)).toEqual(['b', 'a']);
    expect(r[0]!.overdueCount).toBe(1);
  });

  it('记录最早到期时间', () => {
    const r = mergeTodosByTask([
      { id: '1', taskId: 'a', taskName: 'A', title: 'x', severity: null, dueAt: '2026-10-05' },
      { id: '2', taskId: 'a', taskName: 'A', title: 'y', severity: null, dueAt: '2026-10-01' },
    ]);
    expect(r[0]!.earliestDue).toBe('2026-10-01');
  });
});

describe('reviewTaskRows', () => {
  it('后端给了 tasks 就原样使用（数量是真实数，不被截断）', () => {
    const tasks = [
      { taskId: 'a', taskName: '任务A', count: 76, topSeverity: 'HIGH', titles: ['x'] },
    ];
    expect(reviewTaskRows({ items: [], tasks })).toBe(tasks);
  });

  it('后端没给 tasks（老版本）时回退到风险项合并', () => {
    const rows = reviewTaskRows({
      items: [
        { id: '1', taskId: 'a', taskName: 'A', title: 't1', severity: 'LOW' },
        { id: '2', taskId: 'a', taskName: 'A', title: 't2', severity: 'HIGH' },
      ],
    });
    expect(rows).toEqual([
      {
        taskId: 'a',
        taskName: 'A',
        count: 2,
        topSeverity: 'HIGH',
        titles: ['t2', 't1'],
        tenantId: null,
      },
    ]);
  });
});
