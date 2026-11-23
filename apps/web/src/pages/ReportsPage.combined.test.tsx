// 2.6.2 Word 下载、2.6.3 组合报告：报告列表入口、列表标记、详情任务清单与下载格式。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import { ReportsPage } from './ReportsPage';

const apiMock = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  download: vi.fn(),
  createCombined: vi.fn(),
  taskList: vi.fn(),
  targetList: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  hasPermission: vi.fn((_code: string) => true),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    reports: {
      list: apiMock.list,
      get: apiMock.get,
      download: apiMock.download,
      createCombined: apiMock.createCombined,
    },
    evalTasks: { list: apiMock.taskList },
    modelTargets: { list: apiMock.targetList },
  },
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: authMock.hasPermission }),
}));

const TASK_A = '11111111-1111-4111-8111-111111111111';
const TASK_B = '22222222-2222-4222-8222-222222222222';
const TASK_C = '33333333-3333-4333-8333-333333333333';

const severityRisk = { bySeverity: { HIGH: 2 }, byRiskCategory: {}, byRiskDomain: {} };

const combinedListItem = {
  id: 'report-comb',
  taskId: null,
  title: '季度组合报告',
  format: 'markdown',
  kind: 'combined',
  taskCount: 3,
  summary: {
    kind: 'combined',
    headline: '组合 3 个评估任务，共 30 个测试项，发现风险 7 项',
    metrics: { taskCount: 3 },
    totalQuestions: 30,
    processedQuestions: 30,
    passedCount: 18,
    failedCount: 12,
    errorCount: 0,
    wrongAnswerCount: 0,
    evidenceFindingCount: 7,
    findingCount: 7,
    verdictDistribution: {},
    severityDistribution: { HIGH: 7 },
  },
  passRate: null,
  totalQuestions: 30,
  riskDistribution: { bySeverity: { HIGH: 7 }, byRiskCategory: {}, byRiskDomain: {} },
  generatedById: null,
  createdAt: '2026-11-21T08:00:00.000Z',
};

const snapTask = (id: string, name: string, deleted: boolean, movedOut = false) => ({
  id,
  name,
  deleted,
  movedOut,
  targetName: `${name}的对象`,
  model: 'model-x',
  startedAt: '2026-11-20T02:00:00.000Z',
  finishedAt: '2026-11-20T03:00:00.000Z',
  totalQuestions: 10,
  passedCount: 6,
  failedCount: 4,
  errorCount: 0,
  passRate: 0.6,
  score: 82.5,
  findingCount: 2,
  riskDistribution: severityRisk,
});

const combinedDetail = {
  ...combinedListItem,
  content: '# 季度组合报告',
  summary: {
    kind: 'combined',
    headline: '组合 3 个评估任务，共 30 个测试项，发现风险 7 项',
    topRisks: [
      {
        title: '越狱绕过',
        severity: 'HIGH',
        severityLabel: '高危',
        domainLabel: '提示词注入/越狱风险',
        count: 2,
        taskIds: [TASK_A, TASK_C],
      },
    ],
  },
  tasks: [
    snapTask(TASK_A, '任务甲', false),
    snapTask(TASK_B, '任务乙', false),
    snapTask(TASK_C, '任务丙', true),
  ],
};

const plainReport = {
  id: 'report-1',
  taskId: TASK_A,
  title: '通用评估报告',
  format: 'markdown',
  kind: 'safety_overview',
  content: '# 通用评估报告',
  summary: {
    totalQuestions: 10,
    processedQuestions: 10,
    passedCount: 8,
    failedCount: 2,
    errorCount: 0,
    wrongAnswerCount: 1,
    findingCount: 2,
    conclusionSnapshot: {
      schemaVersion: 1,
      policyVersion: 'report-conclusion-v1',
      scopeKind: 'TASK',
      taskCompleted: true,
      resultDetailsAvailable: true,
      taskCountersMatch: true,
      missingEngineRunCount: 0,
      source: 'DETERMINISTIC_RULE',
      basis: 'ACTIVE_RISK_AND_EXECUTION_COVERAGE',
      state: 'RISK_DETECTED',
      coverageComplete: true,
      reasonCodes: ['ACTIVE_RISK_PRESENT'],
      activeRiskCount: 2,
      counts: {
        expected: 10,
        observed: 10,
        valid: 10,
        pass: 8,
        fail: 2,
        activeFailCount: 2,
        excludedFailCount: 0,
        unexplainedFailCount: 0,
        error: 0,
        unknown: 0,
        missingVerdict: 0,
        modelCallError: 0,
        engineRunTotal: 1,
        engineRunFailed: 0,
        engineRunSkipped: 0,
        engineRunNonterminal: 0,
        engineRunPartialSkip: 0,
        skippedEvaluation: 0,
        unobservedResult: 0,
      },
      passRate: 0.8,
      validDecisionRate: 1,
    },
    verdictDistribution: { PASS: 8, FAIL: 2 },
    severityDistribution: { HIGH: 2 },
    charts: {
      passRatePercent: 80,
      severity: [{ key: 'HIGH', label: '高危', value: 2 }],
      verdict: [
        { key: 'PASS', label: '通过', value: 8 },
        { key: 'FAIL', label: '风险', value: 2 },
      ],
      riskCategory: [],
      riskDomain: [],
      engineStatus: [],
    },
  },
  passRate: 0.8,
  totalQuestions: 10,
  riskDistribution: { bySeverity: { HIGH: 2 }, byRiskCategory: {}, byRiskDomain: {} },
  generatedById: null,
  createdAt: '2026-11-20T08:00:00.000Z',
};

const completedTask = (id: string, name: string) => ({
  id,
  name,
  status: 'COMPLETED',
  modelTarget: { id: 'target-1', name: '对象一' },
  finishedAt: '2026-11-20T03:00:00.000Z',
  evalScore: 80,
  riskLevels: { HIGH: 1, MEDIUM: 0, LOW: 0 },
});

function renderPage(entry = '/reports') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <ToastProvider>
          <ReportsPage />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('报告 Word 下载与组合报告', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.hasPermission.mockImplementation(() => true);
    apiMock.list.mockResolvedValue({
      items: [combinedListItem],
      total: 1,
      page: 1,
      pageSize: 10,
    });
    apiMock.get.mockResolvedValue(combinedDetail);
    apiMock.download.mockResolvedValue(undefined);
    apiMock.targetList.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });
    apiMock.taskList.mockResolvedValue({
      items: [
        completedTask(TASK_A, '已完成任务甲'),
        completedTask(TASK_B, '已完成任务乙'),
        completedTask(TASK_C, '已完成任务丙'),
      ],
      total: 3,
      page: 1,
      pageSize: 10,
    });
    apiMock.createCombined.mockResolvedValue({ ...combinedDetail, id: 'report-new' });
  });

  it('通用报告详情的「下载 Word」按 docx 格式下载；没改导出范围和章节时不传', async () => {
    apiMock.list.mockResolvedValue({ items: [plainReport], total: 1, page: 1, pageSize: 10 });
    apiMock.get.mockResolvedValue(plainReport);
    renderPage('/reports?reportId=report-1');
    await userEvent.click(await screen.findByRole('button', { name: '下载 Word' }));
    await waitFor(() =>
      expect(apiMock.download).toHaveBeenCalledWith(
        'report-1',
        { severity: [], riskDomain: [] },
        'docx',
      ),
    );
  });

  it('列表里组合报告标「组合 · N 个任务」，详情任务名可跳转，已删除的任务标出', async () => {
    renderPage();
    expect(await screen.findByText('组合 · 3 个任务')).toBeInTheDocument();
    expect(screen.queryByText(/缺少统一评估结论快照/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '重新生成' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '查看' }));
    const link = await screen.findByRole('link', { name: '任务甲' });
    expect(link.getAttribute('href')).toBe(`/eval-tasks/${TASK_A}`);
    expect(screen.getByRole('link', { name: '任务乙' }).getAttribute('href')).toBe(
      `/eval-tasks/${TASK_B}`,
    );
    expect(screen.queryByRole('link', { name: '任务丙' })).not.toBeInTheDocument();
    expect(screen.getAllByText('任务已删除').length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole('button', { name: '下载 Word' }));
    await waitFor(() => expect(apiMock.download).toHaveBeenCalledWith('report-comb', {}, 'docx'));
    await userEvent.click(screen.getByRole('button', { name: /生成并下载 PDF/ }));
    await waitFor(() => expect(apiMock.download).toHaveBeenCalledWith('report-comb', {}, 'pdf'));
  });

  it('组合报告入口：只列已完成任务、复用任务筛选，少于 2 个任务时提交按钮置灰', async () => {
    renderPage();
    await screen.findByText('季度组合报告');
    await userEvent.click(screen.getByRole('button', { name: '组合报告' }));
    const dialog = await screen.findByRole('dialog', { name: '组合报告' });

    await within(dialog).findByText('已完成任务甲');
    expect(apiMock.taskList).toHaveBeenCalledWith(expect.objectContaining({ status: 'COMPLETED' }));

    await userEvent.type(within(dialog).getByPlaceholderText('按任务名称搜索…'), '甲');
    await userEvent.click(within(dialog).getByRole('button', { name: '搜索' }));
    await waitFor(() =>
      expect(apiMock.taskList).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'COMPLETED', keyword: '甲' }),
      ),
    );

    await userEvent.type(within(dialog).getByLabelText(/报告标题/), '季度组合');
    const submit = within(dialog).getByRole('button', { name: '生成组合报告' });
    expect(submit).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('checkbox', { name: '选择：已完成任务甲' }));
    expect(submit).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('checkbox', { name: '选择：已完成任务乙' }));
    expect(submit).toBeEnabled();

    await userEvent.click(submit);
    await waitFor(() =>
      expect(apiMock.createCombined).toHaveBeenCalledWith({
        title: '季度组合',
        taskIds: [TASK_A, TASK_B],
      }),
    );
  });

  it('组合报告弹窗列出已选任务：翻页、改筛选后仍在，可逐个移除', async () => {
    renderPage();
    await screen.findByText('季度组合报告');
    await userEvent.click(screen.getByRole('button', { name: '组合报告' }));
    const dialog = await screen.findByRole('dialog', { name: '组合报告' });
    await userEvent.type(within(dialog).getByLabelText(/报告标题/), '季度组合');
    await userEvent.click(
      await within(dialog).findByRole('checkbox', { name: '选择：已完成任务甲' }),
    );
    await userEvent.click(within(dialog).getByRole('checkbox', { name: '选择：已完成任务乙' }));

    // 改筛选后表格里只剩任务丙，已选的甲、乙仍列在上方
    apiMock.taskList.mockResolvedValue({
      items: [completedTask(TASK_C, '已完成任务丙')],
      total: 1,
      page: 1,
      pageSize: 10,
    });
    await userEvent.type(within(dialog).getByPlaceholderText('按任务名称搜索…'), '丙');
    await userEvent.click(within(dialog).getByRole('button', { name: '搜索' }));
    await within(dialog).findByRole('checkbox', { name: '选择：已完成任务丙' });
    expect(within(dialog).queryByRole('checkbox', { name: '选择：已完成任务甲' })).toBeNull();
    const chosen = within(dialog).getByRole('list', { name: '已选任务' });
    expect(within(chosen).getByText('已完成任务甲')).toBeInTheDocument();
    expect(within(chosen).getByText('已完成任务乙')).toBeInTheDocument();

    await userEvent.click(within(chosen).getByRole('button', { name: '移除：已完成任务甲' }));
    expect(within(chosen).queryByText('已完成任务甲')).toBeNull();
    const submit = within(dialog).getByRole('button', { name: '生成组合报告' });
    expect(submit).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('checkbox', { name: '选择：已完成任务丙' }));
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    await waitFor(() =>
      expect(apiMock.createCombined).toHaveBeenCalledWith({
        title: '季度组合',
        taskIds: [TASK_B, TASK_C],
      }),
    );
  });

  it('详情里已迁到别的租户的任务标「任务已移出本租户」，不能跳转', async () => {
    apiMock.get.mockResolvedValue({
      ...combinedDetail,
      tasks: [
        snapTask(TASK_A, '任务甲', false),
        snapTask(TASK_B, '任务乙', false, true),
        snapTask(TASK_C, '任务丙', true),
      ],
    });
    renderPage('/reports?reportId=report-comb');
    expect(await screen.findByRole('link', { name: '任务甲' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '任务乙' })).not.toBeInTheDocument();
    expect(screen.getAllByText('任务已移出本租户').length).toBeGreaterThan(0);
    expect(screen.getAllByText('任务已删除').length).toBeGreaterThan(0);
    expect(screen.queryByText(/（已删除）/)).not.toBeInTheDocument();
  });

  it('没有生成报告权限时不显示组合报告入口', async () => {
    authMock.hasPermission.mockImplementation((code: string) => code !== 'report:generate');
    renderPage();
    await screen.findByText('季度组合报告');
    expect(screen.queryByRole('button', { name: '组合报告' })).not.toBeInTheDocument();
  });
});
