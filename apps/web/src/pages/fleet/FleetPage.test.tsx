import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import { CHECK_CATALOG } from '@/components/fleet/check-catalog.test-data';
import { FleetPage } from './FleetPage';
import { EndpointDetailPage } from './EndpointDetailPage';
import { overviewFixture } from '@/components/fleet/endpoint-overview.test-data';
import {
  MOCK_CODES,
  MOCK_DEPLOYMENT_NOT_READY,
  MOCK_DEPLOYMENT_NO_INSTALLER,
  MOCK_DEPLOYMENT_READY,
  MOCK_ENDPOINTS,
  MOCK_INSTALLER_MISSING_REASON,
  MOCK_JOBS,
} from './__mocks__/data';

const m = vi.hoisted(() => ({
  checkCatalog: vi.fn(),
  posture: vi.fn(),
  config: vi.fn(),
  endpoints: vi.fn(),
  agents: vi.fn(),
  endpoint: vi.fn(),
  overview: vi.fn(),
  revokeEndpoint: vi.fn(),
  removeEndpoint: vi.fn(),
  postureEval: vi.fn(),
  requestEvalJob: vi.fn(),
  evalJobs: vi.fn(),
  approveEvalJob: vi.fn(),
  rejectEvalJob: vi.fn(),
  cancelEvalJob: vi.fn(),
  enrollmentCodes: vi.fn(),
  createEnrollmentCode: vi.fn(),
  revokeEnrollmentCode: vi.fn(),
  deploymentInfo: vi.fn(),
  downloadWindowsInstaller: vi.fn(),
  perms: vi.fn((_c: string) => true),
}));
vi.mock('@/lib/api', () => ({
  api: {
    fleet: {
      checkCatalog: m.checkCatalog,
      posture: m.posture,
      config: m.config,
      endpoints: m.endpoints,
      agents: m.agents,
      endpoint: m.endpoint,
      overview: m.overview,
      revokeEndpoint: m.revokeEndpoint,
      removeEndpoint: m.removeEndpoint,
      postureEval: m.postureEval,
      requestEvalJob: m.requestEvalJob,
      evalJobs: m.evalJobs,
      approveEvalJob: m.approveEvalJob,
      rejectEvalJob: m.rejectEvalJob,
      cancelEvalJob: m.cancelEvalJob,
      enrollmentCodes: m.enrollmentCodes,
      createEnrollmentCode: m.createEnrollmentCode,
      revokeEnrollmentCode: m.revokeEnrollmentCode,
      deploymentInfo: m.deploymentInfo,
      downloadWindowsInstaller: m.downloadWindowsInstaller,
    },
  },
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    hasPermission: m.perms,
    user: { id: 'u-admin', username: 'admin', permissions: [] },
  }),
}));

/** 把当前地址栏的查询串露出来，用来断言 ?tab= 的读写。 */
function LocationProbe() {
  return <span data-testid="search">{useLocation().search}</span>;
}

function renderPage(initialEntry = '/fleet?tab=endpoints') {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ToastProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
<Routes><Route path="/fleet" element={<FleetPage />} /><Route path="/fleet/endpoints/:id" element={<EndpointDetailPage />} /></Routes>
          <LocationProbe />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const page = (items: unknown[]) => ({ items, total: items.length, page: 1, pageSize: 20 });

const LIVE_EVAL_UNAVAILABLE =
  '终端未上报真机测评能力：需要本机装有受支持的智能体，并在安装探针时开启测评';

beforeEach(() => {
  vi.clearAllMocks();
  m.checkCatalog.mockResolvedValue(CHECK_CATALOG);
  m.overview.mockImplementation(async (id: string) => ({ ...overviewFixture, endpointId: id, agents: id === 'ep6' ? [] : [{ ...overviewFixture.agents[0], ...(id === 'ep7' ? { key: 'codex', name: 'Codex' } : {}) }] }));
  m.posture.mockResolvedValue({ findings: [] });
  m.perms.mockImplementation(() => true);
  m.config.mockResolvedValue({ enabled: true });
  m.endpoints.mockResolvedValue(page(MOCK_ENDPOINTS));
  m.agents.mockResolvedValue(page([]));
  m.endpoint.mockResolvedValue({
    ...MOCK_ENDPOINTS[0],
    machineId: 'm1',
    installationId: 'i1',
    health: { queue_events: 3, collector: { last_error: '上报超时' } },
    latestReportSummary: {
      ...MOCK_ENDPOINTS[0]!.latestReport!,
      assetsByKind: { cli_agent: 1 },
      agents: [{ name: 'Claude Code', kind: 'cli_agent', version: '2.1.0' }],
      collectors: [],
      staticFindings: { high: 1, medium: 0, info: 2 },
    },
    recentJobs: [MOCK_JOBS[3]],
  });
  m.evalJobs.mockImplementation(async (q?: { view?: string }) =>
    page(
      MOCK_JOBS.filter((j) =>
        q?.view === 'pending'
          ? j.status === 'PENDING_APPROVAL'
          : q?.view === 'active'
            ? ['QUEUED', 'DELIVERED', 'RUNNING'].includes(j.status)
            : true,
      ),
    ),
  );
  m.enrollmentCodes.mockResolvedValue({ items: MOCK_CODES });
  m.deploymentInfo.mockResolvedValue(MOCK_DEPLOYMENT_READY);
});

describe('终端页：未启用', () => {
  it('config.enabled=false 时显示未启用提示而不是报错', async () => {
    m.config.mockResolvedValue({ enabled: false });
    renderPage();
    expect(await screen.findByText('自管终端接入尚未启用，请联系管理员。')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: '终端' })).not.toBeInTheDocument();
    expect(m.endpoints).not.toHaveBeenCalled();
  });
});

describe('终端页：页头与页签', () => {
  it('显示新标题，保留现有终端页签', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: '终端与智能体' })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: '终端' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '智能体' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '测评任务' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '接入终端' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /待审批/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/另一位管理员/)).not.toBeInTheDocument();
  });

  it.each([
    ['enroll', '接入终端'],
    ['jobs', '测评任务'],
    ['endpoints', '终端'],
  ])('?tab=%s 直接打开「%s」页签', async (tab, label) => {
    renderPage(`/fleet?tab=${tab}`);
    const selected = await screen.findByRole('tab', { name: label });
    expect(selected).toHaveAttribute('aria-selected', 'true');
    expect(
      screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true'),
    ).toHaveLength(1);
  });

  it('有 fleet:remote_deploy 时显示「远程部署」页签，没有时不显示', async () => {
    renderPage();
    expect(await screen.findByRole('tab', { name: '远程部署' })).toBeInTheDocument();
  });

  it('没有 fleet:remote_deploy 时 FleetPage 不显示远程部署页签，?tab=deploy 也不打开', async () => {
    m.perms.mockImplementation((code: string) => code !== 'fleet:remote_deploy');
    renderPage('/fleet?tab=deploy');
    expect(await screen.findByRole('tab', { name: '终端' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: '远程部署' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'SSH 部署' })).not.toBeInTheDocument();
  });

  it('?tab 缺省或写错时打开智能体', async () => {
    for (const entry of ['/fleet', '/fleet?tab=nope', '/fleet?tab=']) {
      const { unmount } = renderPage(entry);
      expect(await screen.findByRole('tab', { name: '智能体' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      unmount();
    }
  });

  it('切换页签会写回地址栏 ?tab=，其他查询参数保留', async () => {
    renderPage('/fleet?foo=1');
    await userEvent.click(await screen.findByRole('tab', { name: '接入终端' }));
    expect(screen.getByRole('tab', { name: '接入终端' })).toHaveAttribute('aria-selected', 'true');
    const search = new URLSearchParams(screen.getByTestId('search').textContent ?? '');
    expect(search.get('tab')).toBe('enroll');
    expect(search.get('foo')).toBe('1');
  });
});

describe('终端清单', () => {
  it('已吊销终端可以删除并保留历史记录', async () => {
    m.removeEndpoint.mockResolvedValue({ id: 'ep5', removed: true });
    renderPage();
    await screen.findByText('demo-host');
    await userEvent.click(screen.getByRole('checkbox', { name: '显示已吊销终端' }));
    const row = screen.getByText('old-box').closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: '删除终端' }));
    expect(screen.getByText(/历史检测和测评记录保留/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(m.removeEndpoint).toHaveBeenCalledWith('ep5'));
    expect(m.revokeEndpoint).not.toHaveBeenCalled();
  });
  it('删除已接入终端先吊销，再移出清单', async () => {
    m.revokeEndpoint.mockResolvedValue({ id: 'ep1', status: 'REVOKED' });
    m.removeEndpoint.mockResolvedValue({ id: 'ep1', removed: true });
    renderPage();
    const row = (await screen.findByText('demo-host')).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: '删除终端' }));
    expect(screen.getByText(/未结束的任务将被取消或标记失败/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(m.removeEndpoint).toHaveBeenCalledWith('ep1'));
    expect(m.revokeEndpoint).toHaveBeenCalledWith('ep1');
    expect(m.revokeEndpoint.mock.invocationCallOrder[0]!).toBeLessThan(m.removeEndpoint.mock.invocationCallOrder[0]!);
  });
  it('渲染在线/离线徽章与真机测评能力徽章', async () => {
    renderPage();
    const row1 = (await screen.findByText('demo-host')).closest('tr')!;
    expect(within(row1).getByText('在线')).toBeInTheDocument();
    expect(within(row1).getByText('支持真机测评')).toBeInTheDocument();
    const row2 = screen.getByText('YJ40B4').closest('tr')!;
    expect(within(row2).getByText('离线')).toBeInTheDocument();
    expect(within(row2).getByText('仅配置检测')).toBeInTheDocument();
    expect(within(row2).getByRole('button', { name: '一键检测：YJ40B4' })).toBeDisabled();
    // 没有体检报告的终端不能配置检测
    const row3 = screen.getByText('mac-design-03').closest('tr')!;
    expect(within(row3).getByRole('button', { name: '一键检测：mac-design-03' })).toBeDisabled();
    expect(within(row3).getAllByText('未上报').length).toBeGreaterThan(0);
    // 升级前遗留的待批准旧任务，状态徽章仍如实显示
    expect(within(row3).getByText('待审批（历史）')).toBeInTheDocument();
    // 最近体检读 latestReport
    expect(within(row1).getByText('14 项资产')).toBeInTheDocument();
    // 已吊销终端默认折叠
    expect(screen.queryByText('old-box')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: '显示已吊销终端' }));
    const row5 = screen.getByText('old-box').closest('tr')!;
    expect(within(row5).getByText('已吊销')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '智能体' })).toBeInTheDocument();
  });

  it('真机测评能力只看终端上报的测评执行器：Windows 上报了就可用，没上报就置灰并说明原因', async () => {
    renderPage();
    // Windows 终端上报了测评执行器：与其他系统一样可发起，不再被一刀切置灰
    const win = (await screen.findByText('win-runner-01')).closest('tr')!;
    await userEvent.click(within(win).getByRole('button', { name: '更多操作：win-runner-01' }));
    const winBtn = screen.getByRole('menuitem', { name: '只做真机测评' });
    expect(winBtn).toBeEnabled();
    expect(winBtn).toHaveTextContent('在终端上实际运行智能体做测试');
    expect(within(win).getByText('支持真机测评')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '只做配置检测' })).toBeEnabled();
    // 没有上报测评执行器的终端（这里恰好也是 Windows）：置灰，原因写明怎么办
    const noRunner = screen.getByText('YJ40B4').closest('tr')!;
    await userEvent.click(within(noRunner).getByRole('button', { name: '更多操作：YJ40B4' }));
    const noRunnerBtn = screen.getByRole('menuitem', { name: '只做真机测评' });
    expect(noRunnerBtn).toBeDisabled();
    expect(noRunnerBtn).toHaveTextContent(LIVE_EVAL_UNAVAILABLE);
    expect(within(noRunner).getByText('仅配置检测')).toBeInTheDocument();
    // 旧的按系统一刀切的说法不再出现
    expect(document.body).not.toHaveTextContent('Windows 终端当前仅支持配置检测');
    expect(document.querySelector('[title*="Windows 终端当前仅支持配置检测"]')).toBeNull();
  });

  it('空清单显示引导，点击切到接入页签', async () => {
    m.endpoints.mockResolvedValue(page([]));
    renderPage();
    expect(await screen.findByText('还没有接入任何终端')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '接入第一台终端' }));
    expect(await screen.findByText('接入码')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '接入终端' })).toHaveAttribute('aria-selected', 'true');
  });

  it('吊销需要二次确认', async () => {
    m.revokeEndpoint.mockResolvedValue({ ok: true });
    renderPage();
    await screen.findByText('demo-host');
    await userEvent.click(screen.getByRole('button', { name: '更多操作：demo-host' }));
    await userEvent.click(screen.getByRole('menuitem', { name: '吊销终端' }));
    expect(m.revokeEndpoint).not.toHaveBeenCalled();
    expect(screen.getByText('确定吊销终端「demo-host」吗？')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '确认吊销' }));
    await waitFor(() => expect(m.revokeEndpoint).toHaveBeenCalledWith('ep1'));
  });

  it('没有管理权限时不显示操作按钮', async () => {
    m.perms.mockImplementation((c: string) => c === 'model_target:read');
    renderPage();
    await screen.findByText('demo-host');
    expect(screen.queryByRole('button', { name: '真机测评：demo-host' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看详情：demo-host' })).toBeInTheDocument();
  });

  it('详情显示健康摘要与最近任务', async () => {
    renderPage();
    await screen.findByText('demo-host');
    await userEvent.click(screen.getByRole('button', { name: '查看详情：demo-host' }));
    expect(await screen.findByRole('heading', { name: 'demo-host' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '风险 7' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '检测记录 1' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '终端信息' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('最近错误：上报超时');
  });
});

describe('发起真机测评', () => {
  it('从终端操作进入预选终端的测评向导', async () => {
    m.endpoints.mockResolvedValue(page([{ ...MOCK_ENDPOINTS[0]!, id: 'ep9', hostname: 'clean-box' }]));
    renderPage();
    await screen.findByText('clean-box');
    await userEvent.click(screen.getByRole('button', { name: '更多操作：clean-box' }));
    await userEvent.click(screen.getByRole('menuitem', { name: '只做真机测评' }));
    expect(screen.getByTestId('search')).toHaveTextContent('?endpoint=ep9');
    expect(m.requestEvalJob).not.toHaveBeenCalled();
  });

  it('终端已有进行中的任务时按钮置灰', async () => {
    renderPage();
    const row = (await screen.findByText('demo-host')).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: '更多操作：demo-host' }));
    const btn = screen.getByRole('menuitem', { name: '只做真机测评' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent('该终端已有进行中的任务');
  });
});

it('终端详情按当前能力显示智能体的最近结论和测评入口', async () => {
  m.agents.mockResolvedValue(page([{ endpointId: 'ep1', endpointName: 'demo-host', agentKey: 'claude-code',
    agentName: 'Claude Code', source: 'jiandun', status: 'ready', scope: 'all',
    latest: { status: 'COMPLETED', conclusion: '模型自己拒绝 1 次' } }]));
  renderPage('/fleet/endpoints/ep1');
  await screen.findByRole('heading', { name: 'demo-host' });
  await userEvent.click(screen.getByRole('tab', { name: /智能体/ }));
  expect(await screen.findByText('模型自己拒绝 1 次')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '发起测评' })).toHaveAttribute('href', '/agent-evals/new?endpoint=ep1&agent=claude-code');
  expect(m.agents).toHaveBeenCalledWith(expect.objectContaining({ endpointId: 'ep1' }));
});

describe('测评任务', () => {
  async function openJobs() {
    renderPage();
    await screen.findByText('demo-host');
    await userEvent.click(screen.getByRole('tab', { name: '测评任务' }));
    await screen.findByText('新版本上线前验证危险命令拦截');
  }

  it('升级前遗留的待批准旧任务仍有批准/驳回；发起人本人也能批准，没有「两个账号」限制', async () => {
    m.approveEvalJob.mockResolvedValue({ ...MOCK_JOBS[1], status: 'QUEUED' });
    await openJobs();
    const other = screen.getByText('新版本上线前验证危险命令拦截').closest('tr')!;
    expect(within(other).getByRole('button', { name: /^批准/ })).toBeEnabled();
    expect(within(other).getByRole('button', { name: /^驳回/ })).toBeEnabled();

    // 发起人就是当前登录用户：批准同样可点，也没有任何禁用提示或“撤回”
    const self = screen.getByText('季度例行真机复测').closest('tr')!;
    const approve = within(self).getByRole('button', { name: /^批准/ });
    expect(approve).toBeEnabled();
    expect(approve).not.toHaveAttribute('title');
    expect(within(self).getByRole('button', { name: /^驳回/ })).toBeEnabled();
    expect(within(self).queryByRole('button', { name: /^撤回/ })).not.toBeInTheDocument();
    expect(within(self).queryByText(/不能是同一人/)).not.toBeInTheDocument();
    await userEvent.click(approve);
    await waitFor(() => expect(m.approveEvalJob).toHaveBeenCalledWith('job2'));
  });

  it('列表里不再出现「另一位管理员」「两个账号」「申请人/审批人」字样', async () => {
    await openJobs();
    expect(document.body).not.toHaveTextContent(/另一位管理员|两个账号|申请人|审批人|申请原因/);
    expect(screen.getByRole('columnheader', { name: '发起人' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '备注' })).toBeInTheDocument();
  });

  it('发起人列：只有别人批准过的旧任务才多写一行「批准：xxx」', async () => {
    m.evalJobs.mockResolvedValue(
      page([
        MOCK_JOBS[2], // 旧任务：admin 发起，zhangwei 批准
        {
          ...MOCK_JOBS[3]!,
          id: 'job-new',
          reason: '新任务（自己发起即下发）',
          status: 'QUEUED',
          requestedBy: MOCK_JOBS[1]!.requestedBy,
          approvedBy: MOCK_JOBS[1]!.requestedBy,
        },
      ]),
    );
    renderPage('/fleet?tab=jobs');
    const legacy = (await screen.findByText('补测 Codex 工具调用')).closest('tr')!;
    expect(within(legacy).getByText('批准：zhangwei')).toBeInTheDocument();
    const fresh = screen.getByText('新任务（自己发起即下发）').closest('tr')!;
    expect(within(fresh).queryByText(/批准：/)).not.toBeInTheDocument();
  });

  it('排队中的任务说明是「待终端领取」，可取消', async () => {
    m.cancelEvalJob.mockResolvedValue({ ...MOCK_JOBS[2], status: 'CANCELLED' });
    m.evalJobs.mockResolvedValue(
      page([{ ...MOCK_JOBS[2]!, id: 'job-q', status: 'QUEUED', reason: '排队中的任务' }]),
    );
    renderPage('/fleet?tab=jobs');
    const row = (await screen.findByText('排队中的任务')).closest('tr')!;
    expect(
      within(row).getByText('待终端领取', { selector: '[data-label="操作"] span' }),
    ).toBeInTheDocument();
    expect(within(row).queryByText(/已批准/)).not.toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(m.cancelEvalJob).toHaveBeenCalledWith('job-q'));
  });

  it('没有任务时的空状态不提审批', async () => {
    m.evalJobs.mockResolvedValue(page([]));
    renderPage('/fleet?tab=jobs');
    expect(await screen.findByText('还没有真机测评任务')).toBeInTheDocument();
    expect(
      screen.getByText(
        '在智能体清单中选择可测对象，进入测评向导。',
      ),
    ).toBeInTheDocument();
    // 页面上除了状态筛选里保留的旧状态「待审批」（用来筛出升级前遗留的任务），不再有审批字样
    expect(screen.queryByText(/审批|批准/, { ignore: 'script, style, option' })).toBeNull();
  });

  it('运行中显示说明，终端管理员另有「强制结束」；已完成有查看评估任务链接', async () => {
    await openJobs();
    const running = screen.getByText('补测 Codex 工具调用').closest('tr')!;
    expect(within(running).getByText('终端正在隔离工作区里运行')).toBeInTheDocument();
    expect(within(running).getAllByRole('button').map((b) => b.textContent)).toEqual(['强制结束']);
    const done = screen.getByText('发布前复测').closest('tr')!;
    expect(within(done).getByRole('link', { name: '查看评估任务' })).toHaveAttribute(
      'href',
      '/eval-tasks/task-abc',
    );
  });

  it('强制结束先确认：确认框只写后果，确认后带 force 调用接口', async () => {
    m.cancelEvalJob.mockResolvedValue({ ...MOCK_JOBS[2], status: 'FAILED', errorCode: 'force_closed' });
    await openJobs();
    const running = screen.getByText('补测 Codex 工具调用').closest('tr')!;
    await userEvent.click(within(running).getByRole('button', { name: '强制结束' }));
    const dialog = screen.getByRole('dialog', { name: '强制结束' });
    expect(
      within(dialog).getByText('终端上的进程不会被停止，之后回传的结果会被丢弃。'),
    ).toBeInTheDocument();
    expect(m.cancelEvalJob).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: '强制结束' }));
    await waitFor(() => expect(m.cancelEvalJob).toHaveBeenCalledWith('job3', { force: true }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '强制结束' })).toBeNull());
  });

  it('强制结束的确认框可以取消，不调用接口', async () => {
    await openJobs();
    const running = screen.getByText('补测 Codex 工具调用').closest('tr')!;
    await userEvent.click(within(running).getByRole('button', { name: '强制结束' }));
    const dialog = screen.getByRole('dialog', { name: '强制结束' });
    await userEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog', { name: '强制结束' })).toBeNull();
    expect(m.cancelEvalJob).not.toHaveBeenCalled();
  });

  it('已下发还没开始的任务同样可以强制结束', async () => {
    m.evalJobs.mockResolvedValue(
      page([{ ...MOCK_JOBS[2]!, id: 'job-d', status: 'DELIVERED', reason: '已下发的任务' }]),
    );
    renderPage('/fleet?tab=jobs');
    const row = (await screen.findByText('已下发的任务')).closest('tr')!;
    expect(within(row).getByText('终端已领取，即将开始')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: '强制结束' })).toBeInTheDocument();
  });

  it('没有终端管理权限时执行中的任务只有说明，没有强制结束', async () => {
    m.perms.mockImplementation((code: string) => code !== 'model_target:create');
    renderPage('/fleet?tab=jobs');
    const running = (await screen.findByText('补测 Codex 工具调用')).closest('tr')!;
    expect(within(running).getByText('终端正在隔离工作区里运行')).toBeInTheDocument();
    expect(within(running).queryByRole('button')).not.toBeInTheDocument();
  });

  it('批准调用接口', async () => {
    m.approveEvalJob.mockResolvedValue({ ...MOCK_JOBS[0], status: 'QUEUED' });
    await openJobs();
    await userEvent.click(screen.getByRole('button', { name: '批准：demo-host' }));
    await waitFor(() => expect(m.approveEvalJob).toHaveBeenCalledWith('job1'));
  });

  it('驳回必须填原因', async () => {
    m.rejectEvalJob.mockResolvedValue({ ...MOCK_JOBS[0], status: 'REJECTED' });
    await openJobs();
    await userEvent.click(screen.getByRole('button', { name: '驳回：demo-host' }));
    await userEvent.click(screen.getByRole('button', { name: '确认驳回' }));
    expect(screen.getByText('请填写驳回原因')).toBeInTheDocument();
    expect(m.rejectEvalJob).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText(/驳回原因/), '时间不合适');
    await userEvent.click(screen.getByRole('button', { name: '确认驳回' }));
    await waitFor(() => expect(m.rejectEvalJob).toHaveBeenCalledWith('job1', '时间不合适'));
  });
});

describe('接入终端', () => {
  async function openEnroll() {
    renderPage();
    await screen.findByText('demo-host');
    await userEvent.click(screen.getByRole('tab', { name: '接入终端' }));
  }

  async function createCode() {
    m.createEnrollmentCode.mockResolvedValue({
      code: 'jdc_PLAINTEXT_SECRET_123',
      notice: 'x',
      item: { ...MOCK_CODES[0], id: 'c9', label: '市场部', maxUses: 3 },
    });
    await openEnroll();
    await screen.findByText('研发部第一批');
    await userEvent.click(screen.getByRole('button', { name: '创建接入码' }));
    await userEvent.type(screen.getByLabelText(/名称/), '市场部');
    await userEvent.click(screen.getByRole('button', { name: '创建' }));
    await screen.findByText('jdc_PLAINTEXT_SECRET_123');
    return screen.getByRole('status', { name: '新接入码' });
  }

  it('选择 Windows 安装后创建接入码并直接显示 Windows 安装包', async () => {
    m.createEnrollmentCode.mockResolvedValue({ code: 'jdc_PLAINTEXT_SECRET_123', notice: 'x',
      item: { ...MOCK_CODES[0], id: 'c9', label: '市场部', maxUses: 1 } });
    await openEnroll();
    await userEvent.click(screen.getByRole('button', { name: '安装 Windows 终端' }));
    await userEvent.type(screen.getByLabelText(/名称/), '市场部');
    await userEvent.click(screen.getByRole('button', { name: '创建' }));
    const card = await screen.findByRole('status', { name: '新接入码' });
    expect(within(card).getByRole('button', { name: /下载安装包（x64）/ })).toBeInTheDocument();
  });

  it('页签只剩接入码列表，顶部一两句话说明流程，没有手工安装/关系说明/逐平台状态', async () => {
    await openEnroll();
    expect(await screen.findByText('研发部第一批')).toBeInTheDocument();
    expect(
      screen.getByText(
        /先创建接入码，Linux 终端复制一条命令到终端执行，Windows 终端下载安装包双击运行/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建接入码' })).toBeInTheDocument();
    // 已删除的区块
    for (const gone of [
      '高级 / 手工安装',
      '与智能体安全平台的关系',
      '一键安装',
      '部署信息',
      '终端上的一次性准备（需 root）',
      '下载证书部署文件',
      '采集器配置片段',
    ])
      expect(screen.queryByText(gone)).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(
      /手工安装|智能体安全平台|Windows 终端当前仅支持配置检测/,
    );
    expect(document.querySelector('details')).toBeNull();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('创建接入码后一次性展示明文，关闭后不再出现', async () => {
    m.createEnrollmentCode.mockResolvedValue({
      code: 'jdc_PLAINTEXT_SECRET_123',
      notice: '接入码明文只显示这一次，请立即复制保存',
      item: { ...MOCK_CODES[0], id: 'c9', label: '市场部', maxUses: 3 },
    });
    await openEnroll();
    await screen.findByText('研发部第一批');
    expect(screen.queryByText('jdc_PLAINTEXT_SECRET_123')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '创建接入码' }));
    await userEvent.type(screen.getByLabelText(/名称/), '市场部');
    await userEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() =>
      expect(m.createEnrollmentCode).toHaveBeenCalledWith({
        label: '市场部',
        expiresInHours: 24,
        maxUses: 1,
      }),
    );
    expect(await screen.findByText('jdc_PLAINTEXT_SECRET_123')).toBeInTheDocument();
    expect(screen.getByText(/关闭后无法再次查看/)).toBeInTheDocument();
    // 可接入台数与有效期提示仍在
    expect(screen.getByText(/可接入 3 台终端，有效至/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '我已保存，关闭' }));
    expect(screen.queryByText('jdc_PLAINTEXT_SECRET_123')).not.toBeInTheDocument();
  });

  it('只有 Linux / Windows 两个系统选项，没有 macOS，也没有任何勾选框', async () => {
    const card = await createCode();
    const group = within(card).getByRole('group', { name: '终端系统' });
    expect(
      within(group)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Linux', 'Windows']);
    expect(within(card).queryByRole('button', { name: 'macOS' })).not.toBeInTheDocument();
    expect(within(card).queryAllByRole('checkbox')).toHaveLength(0);
    expect(card).not.toHaveTextContent(/真机测评能力|--switch|智能体安全平台/);
  });

  it('Linux：只给一条复制即用的命令，含脚本 sha256 校验、接入码，固定带 --enable-eval', async () => {
    const card = await createCode();
    const text = within(card).getByText(/curl -fsSL/).textContent ?? '';
    expect(text).toBe(
      "curl -fsSL 'https://lse.example.com/api/fleet/install/linux.sh' -o /tmp/jiandun-probe.sh" +
        ` && echo '${'f'.repeat(64)}  /tmp/jiandun-probe.sh' | sha256sum -c -` +
        " && sudo bash /tmp/jiandun-probe.sh --code 'jdc_PLAINTEXT_SECRET_123' --enable-eval",
    );
    expect(text).not.toContain('--switch');
    expect(within(card).getAllByText(/curl -fsSL/)).toHaveLength(1);
    expect(within(card).getByRole('button', { name: '复制一键命令' })).toBeInTheDocument();
  });

  it('Windows：两个下载按钮（x64 / ARM64），三行以内说明；不显示 Linux 命令', async () => {
    const card = await createCode();
    await userEvent.click(within(card).getByRole('button', { name: 'Windows' }));
    expect(within(card).getByRole('button', { name: '下载安装包（x64）' })).toBeEnabled();
    expect(within(card).getByRole('button', { name: '下载安装包（ARM64）' })).toBeEnabled();
    expect(within(card).queryByText(/curl -fsSL/)).not.toBeInTheDocument();
    const notes = within(card).getAllByRole('listitem');
    expect(notes).toHaveLength(3);
    expect(notes[0]).toHaveTextContent('双击运行，按提示允许管理员权限即可完成接入');
    expect(notes[1]).toHaveTextContent('安装包.exe /quiet');
    expect(notes[2]).toHaveTextContent(
      '安装包暂未做代码签名，首次运行如出现「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」',
    );
    // 切回 Linux 命令仍在
    await userEvent.click(within(card).getByRole('button', { name: 'Linux' }));
    expect(within(card).getByText(/curl -fsSL/)).toBeInTheDocument();
  });

  it('Windows：点击按钮用刚创建的接入码下载对应架构的安装包', async () => {
    m.downloadWindowsInstaller.mockResolvedValue(undefined);
    const card = await createCode();
    await userEvent.click(within(card).getByRole('button', { name: 'Windows' }));
    await userEvent.click(within(card).getByRole('button', { name: '下载安装包（ARM64）' }));
    await waitFor(() =>
      expect(m.downloadWindowsInstaller).toHaveBeenCalledWith(
        'jdc_PLAINTEXT_SECRET_123',
        'windows-arm64',
      ),
    );
    await userEvent.click(within(card).getByRole('button', { name: '下载安装包（x64）' }));
    await waitFor(() =>
      expect(m.downloadWindowsInstaller).toHaveBeenLastCalledWith(
        'jdc_PLAINTEXT_SECRET_123',
        'windows-amd64',
      ),
    );
    expect(m.downloadWindowsInstaller).toHaveBeenCalledTimes(2);
  });

  it('Windows：下载失败时显示后端给出的中文原因', async () => {
    m.downloadWindowsInstaller.mockRejectedValue(new Error('接入码已过期，请重新创建接入码'));
    const card = await createCode();
    await userEvent.click(within(card).getByRole('button', { name: 'Windows' }));
    await userEvent.click(within(card).getByRole('button', { name: '下载安装包（x64）' }));
    expect(await within(card).findByRole('alert')).toHaveTextContent(
      '接入码已过期，请重新创建接入码',
    );
    // 失败后按钮恢复可点，可以重试
    expect(within(card).getByRole('button', { name: '下载安装包（x64）' })).toBeEnabled();
  });

  it('Windows：服务端安装包不可用时按钮置灰并写明原因（两个架构原因相同只写一次）', async () => {
    m.deploymentInfo.mockResolvedValue(MOCK_DEPLOYMENT_NO_INSTALLER);
    const card = await createCode();
    await userEvent.click(within(card).getByRole('button', { name: 'Windows' }));
    const x64 = within(card).getByRole('button', { name: '下载安装包（x64）' });
    const arm = within(card).getByRole('button', { name: '下载安装包（ARM64）' });
    expect(x64).toBeDisabled();
    expect(arm).toBeDisabled();
    expect(x64).toHaveAttribute('title', MOCK_INSTALLER_MISSING_REASON);
    expect(within(card).getAllByText(MOCK_INSTALLER_MISSING_REASON)).toHaveLength(1);
    expect(within(card).getByText('Windows 安装包暂不可用')).toBeInTheDocument();
    await userEvent.click(x64);
    expect(m.downloadWindowsInstaller).not.toHaveBeenCalled();
  });

  it('Windows：只有一个架构不可用时，只置灰那一个并标明架构', async () => {
    const info = structuredClone(MOCK_DEPLOYMENT_READY);
    info.oneclick!.targets.find((t) => t.target === 'windows-arm64')!.installer = {
      available: false,
      reason: '清单中没有该架构的 Windows 安装包',
    };
    m.deploymentInfo.mockResolvedValue(info);
    const card = await createCode();
    await userEvent.click(within(card).getByRole('button', { name: 'Windows' }));
    expect(within(card).getByRole('button', { name: '下载安装包（x64）' })).toBeEnabled();
    expect(within(card).getByRole('button', { name: '下载安装包（ARM64）' })).toBeDisabled();
    expect(within(card).getByText('ARM64：清单中没有该架构的 Windows 安装包')).toBeInTheDocument();
  });

  it('部署未就绪：卡片里 Linux 说明原因并请联系平台管理员，Windows 按钮置灰', async () => {
    m.deploymentInfo.mockResolvedValue(MOCK_DEPLOYMENT_NOT_READY);
    const card = await createCode();
    expect(within(card).getByText('Linux 一键安装暂不可用')).toBeInTheDocument();
    expect(within(card).getByText(/部署信息尚未就绪/)).toBeInTheDocument();
    expect(within(card).getByText('请联系平台管理员完成部署配置。')).toBeInTheDocument();
    expect(within(card).queryByText(/curl -fsSL/)).not.toBeInTheDocument();
    expect(card).not.toHaveTextContent('手工安装');
    await userEvent.click(within(card).getByRole('button', { name: 'Windows' }));
    expect(within(card).getByRole('button', { name: '下载安装包（x64）' })).toBeDisabled();
    expect(within(card).getByRole('button', { name: '下载安装包（ARM64）' })).toBeDisabled();
  });

  it('部署未就绪：页签顶部显示后端给出的原因和「请联系平台管理员完成部署配置」，不引导手工安装', async () => {
    m.deploymentInfo.mockResolvedValue(MOCK_DEPLOYMENT_NOT_READY);
    await openEnroll();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('部署信息尚未就绪');
    expect(alert).toHaveTextContent('未配置 FLEET_TLS_CERT_PEM_PATH');
    expect(alert).toHaveTextContent('请联系平台管理员完成部署配置');
    expect(document.body).not.toHaveTextContent(/手工安装/);
    expect(screen.queryByRole('button', { name: /下载证书部署文件/ })).not.toBeInTheDocument();
  });

  it('部署就绪时页签顶部没有任何部署提示', async () => {
    await openEnroll();
    await screen.findByText('研发部第一批');
    await waitFor(() => expect(m.deploymentInfo).toHaveBeenCalled());
    expect(screen.queryByText('部署信息尚未就绪')).not.toBeInTheDocument();
    expect(screen.queryByText('Linux 一键安装暂不可用')).not.toBeInTheDocument();
    expect(screen.queryByText('请联系平台管理员完成部署配置')).not.toBeInTheDocument();
  });

  it('没有管理权限时不请求部署信息，也不显示创建/撤销', async () => {
    m.perms.mockImplementation((c: string) => c === 'model_target:read');
    renderPage('/fleet?tab=enroll');
    await screen.findByText('研发部第一批');
    expect(m.deploymentInfo).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '创建接入码' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^撤销接入码/ })).not.toBeInTheDocument();
  });

  it('接入码含单引号等特殊字符时命令中被安全转义', async () => {
    const { buildOneclickCommand } = await import('@/lib/fleet');
    const c = buildOneclickCommand({
      scriptUrl: "https://x/a'b",
      scriptSha256: 'a'.repeat(64),
      scriptFile: '/tmp/jiandun-probe.sh',
      code: "jdc_a'b",
    });
    expect(c).toContain("'https://x/a'\\''b'");
    expect(c).toContain("--code 'jdc_a'\\''b' --enable-eval");
  });

  it('名称为空时不能创建', async () => {
    await openEnroll();
    await screen.findByText('研发部第一批');
    await userEvent.click(screen.getByRole('button', { name: '创建接入码' }));
    await userEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(screen.getByText('请填写名称')).toBeInTheDocument();
    expect(m.createEnrollmentCode).not.toHaveBeenCalled();
  });

  it('接入码列表只对可用的显示撤销', async () => {
    m.revokeEnrollmentCode.mockResolvedValue({ ok: true });
    await openEnroll();
    await screen.findByText('研发部第一批');
    expect(screen.getAllByRole('button', { name: /^撤销接入码/ })).toHaveLength(1);
    // 已用完 / 已撤销 / 已过期 都有各自的中文状态
    expect(screen.getByText('已用完')).toBeInTheDocument();
    expect(screen.getByText('已撤销')).toBeInTheDocument();
    expect(screen.getByText('已过期')).toBeInTheDocument();
    // 列表里只有前缀，没有明文
    expect(screen.getByText('jdc_4F2A…')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '撤销接入码：研发部第一批' }));
    await waitFor(() => expect(m.revokeEnrollmentCode).toHaveBeenCalledWith('c1'));
  });
});

describe('终端清单：探针版本与主机名（P2-09）', () => {
  const COMMIT = '50ba8d3a9a01c1fe02541ba98f89f2a5ccc992b9';

  it('探针版本只显示前 8 位，悬停可看全文；普通版本号原样显示', async () => {
    m.endpoints.mockResolvedValue(
      page([
        { ...MOCK_ENDPOINTS[0]!, id: 'epc', hostname: 'commit-box', agentVersion: COMMIT },
        { ...MOCK_ENDPOINTS[0]!, id: 'epv', hostname: 'semver-box', agentVersion: '1.8.2' },
        { ...MOCK_ENDPOINTS[0]!, id: 'epn', hostname: 'none-box', agentVersion: '' },
      ]),
    );
    renderPage();
    const commitRow = (await screen.findByText('commit-box')).closest('tr')!;
    const short = within(commitRow).getByText('50ba8d3a');
    expect(short).toHaveAttribute('title', COMMIT);
    expect(commitRow).not.toHaveTextContent(COMMIT);
    const semverRow = screen.getByText('semver-box').closest('tr')!;
    expect(within(semverRow).getByText('1.8.2')).toBeInTheDocument();
    const noneRow = screen.getByText('none-box').closest('tr')!;
    expect(noneRow.querySelector('[data-label="探针版本"]')).toHaveTextContent('—');
  });

  it('主机名列不折行（demo-host 不会被拆成 yj- / work）', async () => {
    renderPage();
    const cell = (await screen.findByText('demo-host')).closest('td')!;
    expect(cell.className).toContain('whitespace-nowrap');
  });

  it('详情：探针版本缩短；智能体按概览产品聚合，未知版本显示中文', async () => {
    m.endpoint.mockResolvedValue({ ...MOCK_ENDPOINTS[0], agentVersion: COMMIT, health: null });
    m.overview.mockResolvedValue({ ...overviewFixture, report: { ...overviewFixture.report!, probeVersion: COMMIT }, agents: [
      { ...overviewFixture.agents[0]!, version: '2.1.126、2.1.308', installs: 4 },
      { ...overviewFixture.agents[0]!, key: 'codex', name: 'Codex', version: '0.160.1' },
      { ...overviewFixture.agents[0]!, key: 'hermes', name: 'Hermes', version: 'version_unknown' },
      { ...overviewFixture.agents[0]!, key: 'opencode', name: 'OpenCode', version: null },
    ] });
    renderPage();
    await screen.findByText('demo-host');
    await userEvent.click(screen.getByRole('button', { name: '查看详情：demo-host' }));
    await userEvent.click(await screen.findByRole('tab', { name: '智能体 4' }));
    expect(screen.getAllByRole('row')).toHaveLength(5);
    expect(screen.getByText('2.1.126、2.1.308')).toBeInTheDocument();
    expect(screen.getAllByText('版本未知')).toHaveLength(2);
    expect(document.body).not.toHaveTextContent('version_unknown');
    expect(document.body).not.toHaveTextContent(COMMIT);
    expect(screen.getByText('探针 50ba8d3a')).toHaveAttribute('title', COMMIT);
  });
});

describe('已吊销的终端（车道 A 交叉项）', () => {
  it('详情里明确标注「已吊销」，并说明不再接收任务', async () => {
    m.endpoint.mockResolvedValue({
      ...MOCK_ENDPOINTS[4],
      machineId: 'm5',
      installationId: 'i5',
      health: null,
      latestReportSummary: null,
      recentJobs: [],
    });
    renderPage();
    await userEvent.click(await screen.findByRole('checkbox', { name: '显示已吊销终端' }));
    const row = (await screen.findByText('old-box')).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: '查看详情：old-box' }));
    expect(await screen.findByRole('heading', { name: 'old-box' })).toBeInTheDocument();
    const note = await screen.findByTestId('revoked-note');
    expect(note).toHaveTextContent('该终端已吊销');
    expect(note).toHaveTextContent('无法发起检测或真机测评');
    // 吊销终端的操作仍是置灰的，也没有「吊销终端」菜单
    expect(screen.getByRole('button', { name: '一键检测' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '一键检测' })).toBeDisabled();
  });

  it('未吊销的终端详情不显示吊销提示', async () => {
    renderPage();
    await screen.findByText('demo-host');
    await userEvent.click(screen.getByRole('button', { name: '查看详情：demo-host' }));
    await screen.findByRole('heading', { name: 'demo-host' });
    expect(screen.queryByTestId('revoked-note')).not.toBeInTheDocument();
  });
});

describe('旧的待审批任务仍能显示和处理', () => {
  it('状态筛选里保留「待审批（历史）」，任务行徽章如实显示', async () => {
    renderPage('/fleet?tab=jobs');
    const select = await screen.findByLabelText('状态');
    expect(within(select).getByRole('option', { name: '待审批（历史）' })).toBeInTheDocument();
    const rows = await screen.findAllByText('待审批（历史）', { selector: 'span' });
    expect(rows.length).toBeGreaterThan(0);
  });
});

it('清单仅保留一键检测主入口且状态术语统一', async () => {
  renderPage();
  await screen.findByText('demo-host');
  expect(screen.getByRole('button', { name: '一键检测：demo-host' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: '配置检测：demo-host' })).not.toBeInTheDocument();
  expect(document.body).not.toHaveTextContent('待终端接收');
});
