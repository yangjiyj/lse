import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLogsPage } from './AuditLogsPage';

const apiMock = vi.hoisted(() => ({ list: vi.fn(), exportLogs: vi.fn() }));

vi.mock('@/lib/api', () => ({
  api: { auditLogs: { list: apiMock.list, export: apiMock.exportLogs } },
}));

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuditLogsPage />
    </QueryClientProvider>,
  );
}

describe('AuditLogsPage terminology', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.list.mockResolvedValue({
      items: [
        {
          id: 'log-1',
          actorId: 'user-1',
          actorName: '管理员',
          action: 'auth.login',
          targetType: 'user',
          targetId: 'user-1',
          ip: '127.0.0.1',
          userAgent: 'test-agent',
          detail: { success: true },
          createdAt: '2026-08-06T01:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 15,
    });
  });

  it('动作筛选支持按「下载」查看所有文件下载日志', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('cell', { name: '管理员' });
    const actionFilter = screen.getByRole('combobox', { name: '动作筛选' });
    await user.selectOptions(actionFilter, '下载');
    await waitFor(() =>
      expect(apiMock.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ category: 'download', action: undefined }),
      ),
    );
    expect(
      within(actionFilter).getByRole('option', { name: '下载样本导入模板' }),
    ).toBeInTheDocument();
    expect(
      within(actionFilter).getByRole('option', { name: '查看敏感信息明文' }),
    ).toBeInTheDocument();
  });

  it('动作、对象类型和详情标题均使用中文业务术语', async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole('cell', { name: '管理员' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '登录系统' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '用户' })).toBeInTheDocument();

    const targetFilter = screen.getByRole('combobox', { name: '对象类型筛选' });
    expect(within(targetFilter).getByRole('option', { name: '授权许可' })).toBeInTheDocument();
    expect(within(targetFilter).getByRole('option', { name: '安全网关演练' })).toBeInTheDocument();
    for (const name of [
      '策略建议',
      '模型文件扫描',
      '评估计划',
      '上线门禁',
      '外部资产评估',
    ]) {
      expect(within(targetFilter).getByRole('option', { name })).toBeInTheDocument();
    }

    await user.click(screen.getByRole('cell', { name: '登录系统' }));
    expect(await screen.findByText('技术详情')).toBeInTheDocument();
    await waitFor(() => expect(apiMock.list).toHaveBeenCalled());
  });

  it('详情列渲染中文摘要而非原始 JSON', async () => {
    apiMock.list.mockResolvedValueOnce({
      items: [
        {
          id: 'log-scan',
          actorId: 'user-1',
          actorName: '管理员',
          action: 'engine.scan',
          targetType: 'eval_task',
          targetId: 'task-1',
          ip: '127.0.0.1',
          userAgent: 'test-agent',
          detail: {
            engine: 'ai-infra-guard',
            status: 'FAILED',
            normalizedCount: 3,
            targets: [{ url: 'https://example.com' }, { url: 'https://example.org' }],
          },
          createdAt: '2026-08-06T01:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 15,
    });

    renderPage();

    expect(await screen.findByText(/加强版红队引擎/)).toBeInTheDocument();
    expect(screen.getByText(/2 个目标/)).toBeInTheDocument();
    expect(screen.getByText(/发现 3 项/)).toBeInTheDocument();
    expect(screen.getByText(/发现 3 项/)).toHaveTextContent(/失败/);
    // 列表里不得出现原始 JSON 结构
    expect(screen.queryByText(/"normalizedCount"/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\{"engine"/)).not.toBeInTheDocument();
  });

  it('导入与网关分析明细各自使用对应的中文摘要', async () => {
    apiMock.list.mockResolvedValueOnce({
      items: [
        {
          id: 'log-import',
          actorId: 'user-1',
          actorName: '管理员',
          action: 'question.import',
          targetType: 'question_set',
          targetId: 'qs-1',
          ip: null,
          userAgent: null,
          detail: { filename: '测试样本.xlsx', imported: 120, failed: 3, templateType: 'STANDARD' },
          createdAt: '2026-08-06T01:00:00.000Z',
        },
        {
          id: 'log-gw',
          actorId: 'user-1',
          actorName: '管理员',
          action: 'gateway_log.analyze',
          targetType: 'eval_task',
          targetId: 'task-2',
          ip: null,
          userAgent: null,
          detail: { totalEvents: 500, riskEvents: 12, findingCount: 4, sourceIp: '10.0.0.9' },
          createdAt: '2026-08-06T01:00:00.000Z',
        },
      ],
      total: 2,
      page: 1,
      pageSize: 15,
    });

    renderPage();

    expect(await screen.findByText(/测试样本\.xlsx/)).toBeInTheDocument();
    expect(screen.getByText(/成功 120 条/)).toBeInTheDocument();
    expect(screen.getByText(/失败 3 条/)).toBeInTheDocument();
    expect(screen.getByText(/分析 500 条日志/)).toBeInTheDocument();
    expect(screen.getByText(/风险 12 条/)).toBeInTheDocument();
    expect(screen.getByText(/来源 10\.0\.0\.9/)).toBeInTheDocument();
  });

  it('明细中的枚举值渲染为中文而非原始技术码', async () => {
    apiMock.list.mockResolvedValueOnce({
      items: [
        {
          id: 'log-report',
          actorId: 'user-1',
          actorName: '管理员',
          action: 'report.generate',
          targetType: 'report',
          targetId: 'rpt-1',
          ip: null,
          userAgent: null,
          detail: { kind: 'comprehensive', passRate: 0.43, taskId: 'task-1' },
          createdAt: '2026-08-06T01:00:00.000Z',
        },
        {
          id: 'log-export',
          actorId: 'user-1',
          actorName: '管理员',
          action: 'wrong_answer.export',
          targetType: 'eval_task',
          targetId: 'task-1',
          ip: null,
          userAgent: null,
          detail: { count: 7, severity: ['HIGH'] },
          createdAt: '2026-08-06T01:00:00.000Z',
        },
        {
          id: 'log-engine',
          actorId: 'user-1',
          actorName: '管理员',
          action: 'engine.scan',
          targetType: 'eval_task',
          targetId: 'task-1',
          ip: null,
          userAgent: null,
          detail: { engine: 'ai-infra-guard', status: 'SUCCESS', normalizedCount: 1, targets: [1] },
          createdAt: '2026-08-06T01:00:00.000Z',
        },
      ],
      total: 3,
      page: 1,
      pageSize: 15,
    });

    renderPage();

    // 报告类型走既有的 REPORT_KIND_LABELS
    expect(await screen.findByText(/综合评估报告/)).toBeInTheDocument();
    expect(screen.queryByText(/comprehensive/)).not.toBeInTheDocument();
    // 严重级别数组映射为中文
    expect(screen.getByText(/高危/)).toBeInTheDocument();
    expect(screen.queryByText(/HIGH/)).not.toBeInTheDocument();
    // 引擎标识走既有的 ENGINE_LABELS
    expect(screen.getByText(/加强版红队引擎/)).toBeInTheDocument();
    expect(screen.queryByText(/ai-infra-guard/)).not.toBeInTheDocument();
  });

  it('未知动作的明细回退为字段计数而非 JSON', async () => {
    apiMock.list.mockResolvedValueOnce({
      items: [
        {
          id: 'log-unknown',
          actorId: null,
          actorName: '系统',
          action: 'future.action',
          targetType: 'future_target',
          targetId: null,
          ip: null,
          userAgent: null,
          detail: { alpha: 1, beta: 'two' },
          createdAt: '2026-08-06T01:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 15,
    });

    renderPage();

    expect(await screen.findByText('2 项明细')).toBeInTheDocument();
    expect(screen.queryByText(/"alpha"/)).not.toBeInTheDocument();
  });

  it('未知动作和对象类型不直接展示技术码', async () => {
    apiMock.list.mockResolvedValueOnce({
      items: [
        {
          id: 'log-2',
          actorId: null,
          actorName: '系统',
          action: 'future.action',
          targetType: 'future_target',
          targetId: null,
          ip: null,
          userAgent: null,
          detail: null,
          createdAt: '2026-08-06T01:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 15,
    });

    renderPage();

    expect(await screen.findByText('其他操作')).toBeInTheDocument();
    expect(screen.getByText('其他对象')).toBeInTheDocument();
    expect(screen.queryByText('future.action')).not.toBeInTheDocument();
    expect(screen.queryByText('future_target')).not.toBeInTheDocument();
  });
});

describe('AuditLogsPage 导出与查看范围', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 15 });
    apiMock.exportLogs.mockResolvedValue(undefined);
  });

  it('按当前筛选条件导出 CSV 和 JSON', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('暂无操作日志');
    await user.selectOptions(screen.getByRole('combobox', { name: '对象类型筛选' }), '角色');
    await user.type(screen.getByPlaceholderText('按操作人搜索…'), 'alice');
    await user.click(screen.getByRole('button', { name: '搜索' }));

    await user.click(screen.getByRole('button', { name: '导出 CSV' }));
    await waitFor(() =>
      expect(apiMock.exportLogs).toHaveBeenCalledWith(
        expect.objectContaining({ targetType: 'role', actorName: 'alice', format: 'csv' }),
      ),
    );
    await user.click(screen.getByRole('button', { name: '导出 JSON' }));
    await waitFor(() =>
      expect(apiMock.exportLogs).toHaveBeenLastCalledWith(
        expect.objectContaining({ targetType: 'role', format: 'json' }),
      ),
    );
  });

  it('导出失败时显示原因', async () => {
    const user = userEvent.setup();
    apiMock.exportLogs.mockRejectedValue(new Error('共 60000 条，单次最多导出 50000 条，请缩小范围'));
    renderPage();
    await screen.findByText('暂无操作日志');
    await user.click(screen.getByRole('button', { name: '导出 CSV' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('请缩小范围');
  });

  it('没有查看权限时显示原因而不是空列表', async () => {
    apiMock.list.mockRejectedValue(new Error('操作日志仅平台管理员可查看'));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('操作日志仅平台管理员可查看');
    expect(screen.queryByText('暂无操作日志')).not.toBeInTheDocument();
  });
});
