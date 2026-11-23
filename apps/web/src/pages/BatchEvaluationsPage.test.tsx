import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import { BatchEvaluationsPage } from './BatchEvaluationsPage';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  start: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  cancel: vi.fn(),
  retryErrors: vi.fn(),
  results: vi.fn(),
  report: vi.fn(),
  downloadReport: vi.fn(),
  targets: vi.fn(),
  sets: vi.fn(),
  permissions: new Set<string>(),
}));
vi.mock('@/lib/api', () => ({
  api: {
    batchEvaluations: mocks,
    modelTargets: { list: mocks.targets },
    questionSets: { list: mocks.sets },
  },
  ApiError: class ApiError extends Error {
    status = 400;
  },
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: (p: string) => mocks.permissions.has(p) }),
}));
vi.mock('@/lib/data-security', () => ({
  useDataSecurity: () => ({
    maskSensitive: true,
    downloadWatermark: true,
    pageWatermark: true,
    canViewPlain: false,
  }),
}));

const plan = {
  id: 'private-plan-id',
  name: '多模型回归',
  status: 'PAUSED',
  strategy: 'ROUND_ROBIN',
  judgeMode: 'MODEL',
  sampleCount: 10,
  targetCount: 1,
  totalSamples: 10,
  processedSamples: 5,
  validSamples: 2,
  failedSamples: 0,
  errorSamples: 2,
  unknownSamples: 1,
  criticalSamples: 0,
  requestsUsed: 20,
  maxRequests: 20,
  stopReason: 'REQUEST_BUDGET_EXHAUSTED',
  createdAt: '2026-09-30T01:00:00Z',
  startedAt: '2026-09-30T01:00:00Z',
  finishedAt: null,
  progress: 0.5,
};
const detail = {
  ...plan,
  seed: 'repeatable',
  samplePlanHash: 'private-hash',
  concurrency: 4,
  targetConcurrency: 2,
  batchSize: 20,
  rpm: 120,
  maxAttempts: 3,
  maxDurationMinutes: 1440,
  runs: [
    {
      id: 'private-run',
      targetId: 'model-1',
      targetName: '客户模型',
      status: 'PAUSED',
      expectedSamples: 10,
      processedSamples: 5,
      validSamples: 2,
      passedSamples: 2,
      failedSamples: 0,
      errorSamples: 2,
      unknownSamples: 1,
      criticalSamples: 0,
      riskRate: 0,
      validRate: 0.4,
      falseRefusalRate: null,
      averageLatencyMs: 100,
      totalTokens: 1000,
    },
  ],
  summary: {
    state: 'INCOMPLETE',
    coverageComplete: false,
    counts: {
      expected: 10,
      processed: 5,
      valid: 2,
      pass: 2,
      fail: 0,
      error: 2,
      unknown: 1,
      critical: 0,
    },
    commonRisks: [],
    recommendations: ['补齐未完成样本后复核。'],
  },
};
function renderPage(initialEntry = '/batch-evaluations') {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ToastProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <BatchEvaluationsPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('BatchEvaluationsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.permissions = new Set([
      'eval_task:read',
      'eval_task:create',
      'eval_task:re_eval',
      'eval_task:log_view',
      'report:read',
      'report:download',
    ]);
    mocks.list.mockResolvedValue({ items: [plan], total: 1, page: 1, pageSize: 10 });
    mocks.get.mockResolvedValue(detail);
    mocks.create.mockResolvedValue({ ...detail, status: 'PENDING' });
    mocks.start.mockResolvedValue({ ...detail, status: 'RUNNING' });
    mocks.resume.mockResolvedValue({ ...detail, status: 'RUNNING' });
    mocks.retryErrors.mockResolvedValue({ ...detail, status: 'RUNNING' });
    mocks.targets.mockImplementation(({ page }: { page: number }) =>
      Promise.resolve({
        items:
          page === 1
            ? [{ id: 'judge-id', name: '判定模型', targetType: 'JUDGE', isActive: true }]
            : [
                { id: 'model-1', name: '客户模型', targetType: 'MODEL', isActive: true },
                { id: 'agent-1', name: '代理入口', targetType: 'AGENT_API', isActive: true },
              ],
        total: 3,
        page,
        pageSize: 1,
      }),
    );
    mocks.sets.mockImplementation(({ page }: { page: number }) =>
      Promise.resolve({
        items: [{ id: `set-${page}`, name: `安全样本库${page}`, questionCount: 100, kind: 'own' }],
        total: 2,
        page,
        pageSize: 1,
      }),
    );
    mocks.results.mockResolvedValue({
      items: [
        {
          id: 'result-1',
          runId: 'private-run',
          targetName: '客户模型',
          sequence: 1,
          prompt: '测试输入',
          response: null,
          verdict: 'ERROR',
          severity: null,
          category: '内容安全',
          errorMessage: '上游超时',
          attempts: 3,
          latencyMs: null,
          totalTokens: 0,
          evidence: [],
        },
      ],
      total: 21,
      page: 1,
      pageSize: 20,
    });
    mocks.report.mockResolvedValue({
      title: '批量报告',
      content: '# 批量报告\n\n结果尚不完整。',
      summary: detail.summary,
      generatedAt: '2026-09-30T01:00:00Z',
    });
  });

  it('地址带 ?id= 时直接打开这次批量评估', async () => {
    renderPage('/batch-evaluations?id=b1');
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('b1'));
  });

  it('loads every selection page, excludes non-model objects, and creates then starts with explicit judge mode', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: '新建批量评估' }));
    const dialog = screen.getByRole('dialog', { name: /新建批量评估/ });
    expect(await within(dialog).findByLabelText('客户模型')).toBeInTheDocument();
    expect(await within(dialog).findByLabelText(/安全样本库2/)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('判定模型')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('代理入口')).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByLabelText('客户模型'));
    fireEvent.click(within(dialog).getByLabelText(/安全样本库2/));
    fireEvent.change(within(dialog).getByLabelText('评估名称'), {
      target: { value: '客户多模型回归' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建并开始' }));
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: '客户多模型回归',
          targetIds: ['model-1'],
          questionSetIds: ['set-2'],
          sampleCount: 200,
          judgeMode: 'MODEL',
        }),
      ),
    );
    expect(mocks.start).toHaveBeenCalledWith('private-plan-id');
    expect(mocks.targets).toHaveBeenCalledWith(expect.objectContaining({ page: 2 }));
  });

  it('keeps incomplete coverage separate from observed valid results and hides private identifiers', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /查看多模型回归/ }));
    expect(await screen.findByText('评估尚不完整')).toBeInTheDocument();
    expect(screen.getByText('客户模型')).toBeInTheDocument();
    expect(
      screen.queryByText(/100%.*通过|安全结论|private-plan-id|private-run|private-hash/),
    ).not.toBeInTheDocument();
    expect(screen.getByText('补齐未完成样本后复核。')).toBeInTheDocument();
  });

  it('allows an exhausted paused plan to continue with an expanded budget', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /查看多模型回归/ }));
    const input = await screen.findByLabelText('继续评估请求上限');
    fireEvent.change(input, { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: '继续评估' }));
    await waitFor(() =>
      expect(mocks.resume).toHaveBeenCalledWith('private-plan-id', {
        maxRequests: 100,
        maxDurationMinutes: 1440,
      }),
    );
  });

  it('recovers a failed plan with an expanded budget and retries exceptional results', async () => {
    mocks.get.mockResolvedValueOnce({ ...detail, status: 'FAILED' });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /查看多模型回归/ }));
    fireEvent.change(await screen.findByLabelText('继续评估请求上限'), {
      target: { value: '100' },
    });
    expect(screen.getByRole('button', { name: '继续评估' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '重试错误与待判定' }));
    await waitFor(() =>
      expect(mocks.retryErrors).toHaveBeenCalledWith('private-plan-id', {
        maxRequests: 100,
        maxDurationMinutes: 1440,
      }),
    );
  });

  it('downloads the selected object report without exposing its identifiers', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /查看多模型回归/ }));
    fireEvent.click(await screen.findByRole('button', { name: '下载客户模型报告' }));
    await waitFor(() =>
      expect(mocks.downloadReport).toHaveBeenCalledWith('private-plan-id', 'private-run'),
    );
  });

  it('filters and paginates result details and presents upstream errors', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /查看多模型回归/ }));
    fireEvent.click(await screen.findByRole('button', { name: '结果明细' }));
    const dialog = screen.getByRole('dialog', { name: /结果明细/ });
    expect(await within(dialog).findByText('上游超时')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('判定结果'), { target: { value: 'ERROR' } });
    await waitFor(() =>
      expect(mocks.results).toHaveBeenLastCalledWith(
        'private-plan-id',
        expect.objectContaining({ verdict: 'ERROR', page: 1 }),
      ),
    );
    fireEvent.click(await within(dialog).findByRole('button', { name: /下一页/ }));
    await waitFor(() =>
      expect(mocks.results).toHaveBeenLastCalledWith(
        'private-plan-id',
        expect.objectContaining({ page: 2 }),
      ),
    );
  });

  it('masks phone numbers in sample previews, model responses, and evidence by default', async () => {
    mocks.results.mockResolvedValueOnce({
      items: [
        {
          id: 'sensitive-result',
          runId: 'private-run',
          targetName: '客户模型',
          sequence: 1,
          prompt: '样本中的手机号：13812345678',
          response: '响应中的手机号：13812345678',
          verdict: 'FAIL',
          severity: 'HIGH',
          category: '内容安全',
          errorMessage: null,
          attempts: 1,
          latencyMs: 10,
          totalTokens: 20,
          evidence: ['证据中的手机号：13812345678'],
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /查看多模型回归/ }));
    fireEvent.click(await screen.findByRole('button', { name: '结果明细' }));
    const dialog = screen.getByRole('dialog', { name: /结果明细/ });
    await waitFor(() => expect(dialog).toHaveTextContent('样本中的手机号：138****5678'));
    expect(dialog).toHaveTextContent('响应中的手机号：138****5678');
    expect(dialog).toHaveTextContent('证据中的手机号：138****5678');
    expect(dialog).not.toHaveTextContent('13812345678');
    expect(within(dialog).queryByRole('button', { name: /查看明文/ })).not.toBeInTheDocument();
  });

  it('shows server judge configuration errors without downgrading to rules', async () => {
    mocks.create.mockRejectedValueOnce(new Error('请先配置独立判定模型'));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: '新建批量评估' }));
    fireEvent.click(await screen.findByLabelText('客户模型'));
    fireEvent.click(await screen.findByLabelText(/安全样本库1/));
    fireEvent.click(screen.getByRole('button', { name: '创建并开始' }));
    expect(await screen.findByText('请先配置独立判定模型')).toBeInTheDocument();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ judgeMode: 'MODEL' }));
  });

  it('样本库列表默认只列种子库和自有样本库，运行记录收进“展开运行记录”折叠区', async () => {
    mocks.sets.mockImplementation(() =>
      Promise.resolve({
        items: [
          { id: 'seed-1', name: '内置种子库甲', questionCount: 50, kind: 'seed' },
          { id: 'own-1', name: '客户自有样本库', questionCount: 30, kind: 'own' },
          { id: 'run-1', name: '[综合评估·自主红队] 运行快照', questionCount: 20, kind: 'run' },
        ],
        total: 3,
        page: 1,
        pageSize: 100,
      }),
    );
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: '新建批量评估' }));
    const dialog = screen.getByRole('dialog', { name: /新建批量评估/ });
    expect(await within(dialog).findByLabelText(/内置种子库甲/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/客户自有样本库/)).toBeInTheDocument();
    const toggle = within(dialog).getByText(/展开运行记录/);
    expect(toggle.closest('details')).not.toHaveAttribute('open');
    fireEvent.click(toggle);
    expect(toggle.closest('details')).toHaveAttribute('open');
    expect(within(dialog).getByLabelText(/运行快照/)).toBeInTheDocument();
  });

  it('样本库列表不含已禁用的样本库', async () => {
    mocks.sets.mockImplementation(() =>
      Promise.resolve({
        items: [
          { id: 'seed-1', name: '内置种子库甲', questionCount: 50, kind: 'seed', enabled: true },
          { id: 'own-off', name: '已停用的自有库', questionCount: 30, kind: 'own', enabled: false },
        ],
        total: 2,
        page: 1,
        pageSize: 100,
      }),
    );
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: '新建批量评估' }));
    const dialog = screen.getByRole('dialog', { name: /新建批量评估/ });
    expect(await within(dialog).findByLabelText(/内置种子库甲/)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/已停用的自有库/)).not.toBeInTheDocument();
    expect(mocks.sets).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });

  it('每个对象样本数默认 200；超过 2000 时先二次确认并显示预估请求次数，确认后才创建', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: '新建批量评估' }));
    const dialog = screen.getByRole('dialog', { name: /新建批量评估/ });
    const samples = await within(dialog).findByLabelText(/每个对象样本数/);
    expect(samples).toHaveValue(200);
    fireEvent.click(await within(dialog).findByLabelText('客户模型'));
    fireEvent.click(await within(dialog).findByLabelText(/安全样本库1/));
    fireEvent.change(samples, { target: { value: '3000' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建并开始' }));
    // 未确认前不创建
    const confirm = await screen.findByRole('dialog', { name: /确认大规模评估/ });
    expect(mocks.create).not.toHaveBeenCalled();
    // 3000 条 × 1 个对象 × 模型判定 2 × 最多尝试 3 次 = 18,000
    expect(within(confirm).getByText(/18,000/)).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole('button', { name: '确认并开始' }));
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ sampleCount: 3000 })),
    );
  });

  it('样本数不超过 2000 时直接创建，不弹二次确认', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: '新建批量评估' }));
    fireEvent.click(await screen.findByLabelText('客户模型'));
    fireEvent.click(await screen.findByLabelText(/安全样本库1/));
    fireEvent.click(screen.getByRole('button', { name: '创建并开始' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog', { name: /确认大规模评估/ })).not.toBeInTheDocument();
  });

  it('uses rule screening only when explicitly selected', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: '新建批量评估' }));
    fireEvent.click(await screen.findByLabelText('客户模型'));
    fireEvent.click(await screen.findByLabelText(/安全样本库1/));
    fireEvent.click(screen.getByLabelText('规则初筛'));
    fireEvent.click(screen.getByRole('button', { name: '创建并开始' }));
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ judgeMode: 'RULES' })),
    );
  });

  it('keeps the created pending plan available when starting fails', async () => {
    mocks.start.mockRejectedValueOnce(new Error('评估队列暂不可用'));
    mocks.get.mockResolvedValueOnce({ ...detail, status: 'PENDING' });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: '新建批量评估' }));
    fireEvent.click(await screen.findByLabelText('客户模型'));
    fireEvent.click(await screen.findByLabelText(/安全样本库1/));
    fireEvent.click(screen.getByRole('button', { name: '创建并开始' }));
    expect(await screen.findByText('评估队列暂不可用')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '开始评估' })).toBeEnabled();
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('renders a markdown report and downloads through the authenticated client', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /查看多模型回归/ }));
    fireEvent.click(await screen.findByRole('button', { name: '查看报告' }));
    expect(await screen.findByRole('heading', { name: '批量报告' })).toBeInTheDocument();
    expect(screen.getByText('结果尚不完整。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '下载报告' }));
    await waitFor(() => expect(mocks.downloadReport).toHaveBeenCalledWith('private-plan-id'));
  });

  it('disables result evidence for accounts without the result permission', async () => {
    mocks.permissions.delete('eval_task:log_view');
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /查看多模型回归/ }));
    expect(await screen.findByRole('button', { name: '结果明细' })).toBeDisabled();
    expect(mocks.results).not.toHaveBeenCalled();
  });

  it('disables duplicate controls until an operation finishes', async () => {
    let finish!: (value: typeof detail) => void;
    mocks.resume.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /查看多模型回归/ }));
    fireEvent.change(await screen.findByLabelText('继续评估请求上限'), {
      target: { value: '100' },
    });
    fireEvent.click(screen.getByRole('button', { name: '继续评估' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '继续评估' })).toBeDisabled());
    expect(screen.getByRole('button', { name: '重试错误与待判定' })).toBeDisabled();
    finish({ ...detail, maxRequests: 100 });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '重试错误与待判定' })).toBeEnabled(),
    );
  });

  it('rejects fractional resume budgets before sending an action', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /查看多模型回归/ }));
    fireEvent.change(await screen.findByLabelText('继续评估请求上限'), {
      target: { value: '100.5' },
    });
    expect(screen.getByRole('button', { name: '继续评估' })).toBeDisabled();
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it('enforces permissions for direct page visits and hides write/report actions', async () => {
    mocks.permissions = new Set();
    const rendered = renderPage();
    expect(await screen.findByText('暂无访问权限')).toBeInTheDocument();
    expect(mocks.list).not.toHaveBeenCalled();
    rendered.unmount();
    mocks.permissions = new Set(['eval_task:read']);
    renderPage();
    expect(screen.queryByRole('button', { name: '新建批量评估' })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /查看多模型回归/ }));
    await screen.findByText('客户模型');
    expect(screen.queryByRole('button', { name: '继续评估' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '查看报告' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下载报告' })).not.toBeInTheDocument();
  });
});
