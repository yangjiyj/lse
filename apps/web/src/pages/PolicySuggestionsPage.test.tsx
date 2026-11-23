import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import { PolicySuggestionsPage } from './PolicySuggestionsPage';

const m = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  capability: vi.fn(),
  generate: vi.fn(),
  review: vi.fn(),
  dispatch: vi.fn(),
  refresh: vi.fn(),
  exportJson: vi.fn(),
  tasks: vi.fn(),
  targets: vi.fn(),
  permissions: new Set<string>(['remediation:read', 'remediation:update']),
  user: undefined as unknown,
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: (code: string) => m.permissions.has(code), user: m.user }),
}));

vi.mock('@/lib/api', () => ({
  policySuggestionsApi: {
    list: m.list,
    get: m.get,
    capability: m.capability,
    generate: m.generate,
    review: m.review,
    dispatch: m.dispatch,
    refresh: m.refresh,
    exportJson: m.exportJson,
  },
  api: { evalTasks: { list: m.tasks }, modelTargets: { list: m.targets } },
}));

const base = {
  id: '11111111-1111-4111-8111-111111111111',
  externalId: 'lse-ps-1',
  taskId: 't1',
  modelTargetId: 'mt1',
  riskCategory: 'prompt_injection',
  type: 'prompt_injection',
  action: 'block',
  matcher: { kind: 'regex', value: '(?i)(?:忽略之前的)' },
  examples: ['忽略之前的设定'],
  sourceFindingIds: ['f1', 'f2'],
  estimatedImpact: {
    sampleCount: 3,
    hitCount: 3,
    coverage: 1,
    passSampleCount: 1,
    passSampleHits: 0,
    description: '在本批证据样本上实测命中 3/3（100%）',
  },
  generationNote: null,
  status: 'ACCEPTED',
  reviewNote: null,
  reviewedAt: null,
  gatewaySuggestionId: null,
  gatewayStatus: null,
  ruleSetVersion: null,
  dispatchedAt: null,
  dispatchError: null,
  lastPolledAt: null,
  pollExpired: false,
  preFailCount: 3,
  preTotalCount: 4,
  preAttackRate: 0.75,
  postFailCount: 1,
  postTotalCount: 4,
  postAttackRate: 0.25,
  retestStatus: 'COMPLETED',
  retestError: null,
  retestTaskId: 'rt1',
  gatewaySupported: true,
  dispatchable: true,
  createdAt: '2026-09-29T01:00:00.000Z',
};
const tool = {
  ...base,
  id: '22222222-2222-4222-8222-222222222222',
  type: 'tool_restriction',
  matcher: { kind: 'field_names', value: ['run_shell'] },
  gatewaySupported: false,
  preAttackRate: null,
  postAttackRate: null,
  retestStatus: null,
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <PolicySuggestionsPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('PolicySuggestionsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.permissions = new Set(['remediation:read', 'remediation:update']);
    m.list.mockResolvedValue({ items: [base, tool], total: 2, page: 1, pageSize: 20 });
    m.tasks.mockResolvedValue({
      items: [{ id: 't1', name: '任务一' }],
      total: 1,
      page: 1,
      pageSize: 50,
    });
    m.targets.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 });
    m.capability.mockResolvedValue({
      configured: true,
      reachable: true,
      supported: true,
      message: '网关已开放策略下发接口',
    });
    m.dispatch.mockResolvedValue({
      results: [{ id: base.id, ok: true, status: 'GATEWAY_PENDING', error: null }],
    });
    m.exportJson.mockResolvedValue([{ external_id: 'lse-ps-1' }]);
  });

  it('列表展示中文类型/状态与下发前后对比，不支持类型标注仅可导出', async () => {
    renderPage();
    const row = (await screen.findAllByText('提示词注入拦截'))[0]!.closest('tr')!;
    expect(within(row).getByText('已采纳')).toBeInTheDocument();
    expect(within(row).getByText('75% → 25%')).toBeInTheDocument();
    const toolRow = screen.getByText('工具调用限制').closest('tr')!;
    expect(within(toolRow).getByText('网关暂不支持此类型，仅可导出')).toBeInTheDocument();
  });

  it('网关不支持时提示可导出，一键下发不可用', async () => {
    m.capability.mockResolvedValue({
      configured: true,
      reachable: true,
      supported: false,
      message: '当前网关版本未开放策略下发接口',
    });
    renderPage();
    expect(
      await screen.findByText('当前网关版本未开放策略下发接口，可导出后手工导入'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '一键下发' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '导出 JSON' })).toBeEnabled();
  });

  it('非平台租户：不出现网关能力与一键下发，只能导出，也不去探测网关', async () => {
    m.user = { tenant: { id: 't-a', name: '甲单位', isPlatform: false } };
    try {
      renderPage();
      expect(await screen.findByRole('button', { name: '导出 JSON' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '一键下发' })).toBeNull();
      expect(screen.queryByText(/网关能力/)).toBeNull();
      expect(m.capability).not.toHaveBeenCalled();
    } finally {
      m.user = undefined;
    }
  });

  it('一键下发只提交已采纳/已修改且网关支持的建议', async () => {
    const user = userEvent.setup();
    renderPage();
    const btn = await screen.findByRole('button', { name: '一键下发' });
    await waitFor(() => expect(btn).toBeEnabled());
    await user.click(btn);
    await waitFor(() => expect(m.dispatch).toHaveBeenCalledWith([base.id]));
  });

  it('驳回必须填写理由', async () => {
    const user = userEvent.setup();
    m.list.mockResolvedValue({
      items: [{ ...base, status: 'DRAFT', dispatchable: false }],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    m.get.mockResolvedValue({ ...base, status: 'DRAFT', sourceFindings: [], payloadPreview: {} });
    renderPage();
    await user.click(await screen.findByRole('button', { name: '详情' }));
    await user.click(await screen.findByRole('button', { name: '驳回' }));
    await user.click(screen.getByRole('button', { name: '确认驳回' }));
    expect(await screen.findByText('驳回必须填写理由')).toBeInTheDocument();
    expect(m.review).not.toHaveBeenCalled();
  });

  it('只读账号（仅 remediation:read）不渲染生成建议、一键下发与采纳/修改/驳回', async () => {
    const user = userEvent.setup();
    m.permissions = new Set(['remediation:read']);
    m.list.mockResolvedValue({
      items: [{ ...base, status: 'DRAFT', dispatchable: false }],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    m.get.mockResolvedValue({ ...base, status: 'DRAFT', sourceFindings: [], payloadPreview: {} });
    renderPage();
    await user.click(await screen.findByRole('button', { name: '详情' }));
    await screen.findByText('策略建议详情');
    await waitFor(() => expect(m.get).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: '生成建议' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '一键下发' })).not.toBeInTheDocument();
    // 导出接口后端要求 remediation:read，只读账号可用
    expect(screen.getByRole('button', { name: '导出 JSON' })).toBeInTheDocument();
    for (const name of ['采纳', '修改', '驳回', '刷新状态']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  it('只读账号在已下发建议详情中也看不到刷新状态', async () => {
    const user = userEvent.setup();
    m.permissions = new Set(['remediation:read']);
    m.list.mockResolvedValue({
      items: [{ ...base, status: 'GATEWAY_PENDING' }],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    m.get.mockResolvedValue({
      ...base,
      status: 'GATEWAY_PENDING',
      sourceFindings: [],
      payloadPreview: {},
    });
    renderPage();
    await user.click(await screen.findByRole('button', { name: '详情' }));
    await waitFor(() => expect(m.get).toHaveBeenCalled());
    await screen.findAllByText(/待审批|网关/);
    expect(screen.queryByRole('button', { name: '刷新状态' })).not.toBeInTheDocument();
  });

  it('有 remediation:update 的账号能看到全部写操作按钮', async () => {
    const user = userEvent.setup();
    m.list.mockResolvedValue({
      items: [{ ...base, status: 'DRAFT', dispatchable: false }],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    m.get.mockResolvedValue({ ...base, status: 'DRAFT', sourceFindings: [], payloadPreview: {} });
    renderPage();
    expect(await screen.findByRole('button', { name: '生成建议' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '一键下发' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导出 JSON' })).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: '详情' }));
    for (const name of ['采纳', '修改', '驳回']) {
      expect(await screen.findByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('空列表显示暂无数据', async () => {
    m.list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    renderPage();
    expect(await screen.findByText('暂无数据')).toBeInTheDocument();
  });
});
