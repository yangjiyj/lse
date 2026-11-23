import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DashboardTodos } from '@/lib/api';
import { MyTodosPage } from './MyTodosPage';

const todos =
  vi.fn<
    (query?: { reviewTaskPage?: number; reviewTaskPageSize?: number }) => Promise<DashboardTodos>
  >();
vi.mock('@/lib/api', () => ({
  api: { dashboard: { todos: (query?: { reviewTaskPage?: number }) => todos(query) } },
}));
const perms = vi.hoisted(() => ({ denied: new Set<string>() }));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: (code: string) => !perms.denied.has(code) }),
}));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <MyTodosPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const empty = { count: 0, items: [] };
function base(overrides: Partial<DashboardTodos>): DashboardTodos {
  return {
    review: empty,
    remediation: empty,
    connection: empty,
    gate: empty,
    gates: { remediation: true, connection: true, planning: true },
    ...overrides,
  };
}

describe('MyTodosPage 门禁未过', () => {
  beforeEach(() => todos.mockReset());

  it('列出最新判定未通过的门禁、原因与跳转', async () => {
    todos.mockResolvedValue(
      base({
        gate: {
          count: 1,
          items: [
            {
              gateId: 'g1',
              gateName: '生产上线门禁',
              modelTargetId: 't1',
              planId: null,
              taskId: 'task-1',
              taskName: '九月回归',
              reasons: ['高风险数超过门槛'],
              evaluatedAt: '2026-09-29T00:00:00.000Z',
            },
          ],
        },
      }),
    );
    renderPage();
    expect(await screen.findByText('门禁未过')).toBeInTheDocument();
    expect(screen.getByText(/生产上线门禁 · 九月回归/)).toBeInTheDocument();
    expect(screen.getByText('高风险数超过门槛')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: '查看任务' }).at(-1)).toHaveAttribute(
      'href',
      '/eval-tasks/task-1',
    );
    expect(screen.getByRole('link', { name: '查看门禁' })).toHaveAttribute('href', '/eval/gates');
    expect(document.body).not.toHaveTextContent('TODO');
  });

  it('无门禁未过时显示暂无数据', async () => {
    todos.mockResolvedValue(base({}));
    renderPage();
    expect(await screen.findByText('门禁未过')).toBeInTheDocument();
    expect(screen.getAllByText('暂无数据').length).toBe(4);
  });

  it('无门禁权限时如实提示，不显示计数', async () => {
    todos.mockResolvedValue(
      base({ gates: { remediation: true, connection: true, planning: false } }),
    );
    renderPage();
    expect(await screen.findByText('暂无门禁权限')).toBeInTheDocument();
  });
});

describe('MyTodosPage 待复核按任务分组', () => {
  beforeEach(() => {
    todos.mockReset();
    perms.denied.clear();
  });

  const group = (n: number, count: number, sev = 'HIGH') => ({
    taskId: `task-${n}`,
    taskName: `任务${n}`,
    count,
    topSeverity: sev,
    latestAt: '2026-10-22T00:00:00.000Z',
    titles: [`发现${n}`],
  });

  it('每个任务旁显示真实待复核数，合计与各任务数量之和一致，并标注统计范围', async () => {
    todos.mockResolvedValue(
      base({
        review: {
          count: 133,
          items: [],
          // 真实数 76 / 8，而不是被截断成 4 / 2
          tasks: [group(1, 76), group(2, 8, 'MEDIUM')],
          taskTotal: 2,
          taskPage: 1,
          taskPageSize: 10,
        },
      }),
    );
    renderPage();
    expect(await screen.findByText('76 项待复核')).toBeInTheDocument();
    expect(screen.getByText('8 项待复核')).toBeInTheDocument();
    expect(screen.queryByText('4 项待复核')).not.toBeInTheDocument();
    // 页头合计 = 待复核合计（133），不被截断
    expect(screen.getByText(/共 133 项待处理/)).toBeInTheDocument();
    expect(screen.getByText(/全部时间 · 涉及 2 个评估任务/)).toBeInTheDocument();
    // 不再出现「仅列出最近 N 项」的截断说明
    expect(document.body).not.toHaveTextContent('仅列出最近');
  });

  it('链接指向风险处置台的同口径待复核列表（可按任务进入）', async () => {
    todos.mockResolvedValue(
      base({ review: { count: 5, items: [], tasks: [group(1, 5)], taskTotal: 1 } }),
    );
    renderPage();
    await screen.findByText('5 项待复核');
    expect(screen.getByRole('link', { name: '去处置台' })).toHaveAttribute(
      'href',
      '/wrong-answers?reviewStatus=pending',
    );
    expect(screen.getByRole('link', { name: '去复核' })).toHaveAttribute(
      'href',
      '/wrong-answers?reviewStatus=pending&taskId=task-1',
    );
  });

  it('没有风险处置台权限时回退到评估任务详情', async () => {
    perms.denied.add('wrong_answer:export');
    todos.mockResolvedValue(
      base({ review: { count: 5, items: [], tasks: [group(1, 5)], taskTotal: 1 } }),
    );
    renderPage();
    await screen.findByText('5 项待复核');
    expect(screen.getByRole('link', { name: '去复核' })).toHaveAttribute(
      'href',
      '/eval-tasks/task-1',
    );
  });

  it('任务超过一页时分页，翻页会按页码重新请求', async () => {
    const page1 = Array.from({ length: 10 }, (_, i) => group(i + 1, 3));
    todos.mockImplementation(async (query) =>
      base({
        review: {
          count: 36,
          items: [],
          tasks: query?.reviewTaskPage === 2 ? [group(11, 3), group(12, 3)] : page1,
          taskTotal: 12,
          taskPage: query?.reviewTaskPage ?? 1,
          taskPageSize: 10,
        },
      }),
    );
    renderPage();
    await screen.findByText('任务1');
    expect(screen.getByText(/第 1-10 条 \/ 共 12 条/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /下一页/ }));
    expect(await screen.findByText('任务11')).toBeInTheDocument();
    expect(todos).toHaveBeenLastCalledWith(expect.objectContaining({ reviewTaskPage: 2 }));
    expect(within(document.body).queryByText('任务1')).not.toBeInTheDocument();
  });

  it('老版本后端没有 tasks 字段时回退到风险项合并，不报错', async () => {
    todos.mockResolvedValue(
      base({
        review: {
          count: 2,
          items: [
            {
              id: 'f1',
              taskId: 'task-9',
              taskName: '旧任务',
              title: '发现A',
              severity: 'HIGH',
              createdAt: '2026-10-22T00:00:00.000Z',
            },
            {
              id: 'f2',
              taskId: 'task-9',
              taskName: '旧任务',
              title: '发现B',
              severity: 'LOW',
              createdAt: '2026-10-22T00:00:00.000Z',
            },
          ],
        },
      }),
    );
    renderPage();
    expect(await screen.findByText('旧任务')).toBeInTheDocument();
    expect(screen.getByText('2 项待复核')).toBeInTheDocument();
  });
});
