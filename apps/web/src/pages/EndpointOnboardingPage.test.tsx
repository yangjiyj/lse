import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import { EndpointOnboardingPage, buildInstallCommands } from './EndpointOnboardingPage';

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  endpoints: vi.fn(),
  list: vi.fn(),
  fleetConfig: vi.fn(),
  perms: vi.fn((_c: string) => true),
}));
vi.mock('@/lib/api', () => ({
  api: {
    endpointEvals: { config: mocks.config, endpoints: mocks.endpoints },
    modelTargets: { list: mocks.list },
    fleet: { config: mocks.fleetConfig },
  },
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ hasPermission: mocks.perms }) }));

const recent = new Date(Date.now() - 3600_000).toISOString();
const old = new Date(Date.now() - 3 * 86400_000).toISOString();
const ENDPOINTS = [
  {
    endpoint_id: 'a',
    hostname: 'demo-host',
    os: 'linux',
    owner_display: 'yj',
    department: '研发中心',
    last_seen_at: recent,
    eval_runner_version: '1',
    agents: [{ product: 'claude-code', version: '2.1.126', headless_capable: true }],
  },
  {
    endpoint_id: 'b',
    hostname: 'YJ40B4',
    os: 'windows',
    owner_display: 'yj',
    department: '综合办公室',
    last_seen_at: old,
    eval_runner_version: null,
    agents: [{ product: 'codex', version: 'version_unknown', headless_capable: true }],
  },
];

function Probe() {
  const loc = useLocation();
  return <div data-testid="state">{JSON.stringify(loc.state)}</div>;
}
function renderPage() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ToastProvider>
        <MemoryRouter initialEntries={['/model-targets/endpoint-onboarding']}>
          <Routes>
            <Route path="/model-targets/endpoint-onboarding" element={<EndpointOnboardingPage />} />
            <Route path="/model-targets" element={<Probe />} />
            <Route path="/settings" element={<div>设置页</div>} />
            <Route path="/fleet" element={<div>终端页</div>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.perms.mockImplementation(() => true);
  mocks.config.mockResolvedValue({
    enabled: true,
    agentshieldBaseUrl: 'https://asp.example:15183',
  });
  mocks.endpoints.mockResolvedValue(ENDPOINTS);
  // 默认视为自管终端接入未启用（接口不存在 / 报错）
  mocks.fleetConfig.mockRejectedValue(new Error('not found'));
  mocks.list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });
});

describe('接入终端智能体页', () => {
  it('渲染终端列表与折叠安装区，命令里填入真实平台地址，占位符保留', async () => {
    renderPage();
    expect(await screen.findByText('A. 在智能体安全平台创建接入码')).toBeInTheDocument();
    expect(screen.getByText('B. 在终端安装探针')).toBeInTheDocument();
    expect(screen.getByText('已接入的终端（可直接复用）')).toBeInTheDocument();
    expect(screen.getAllByText('https://asp.example:15183').length).toBeGreaterThan(0);
    expect(screen.getByText(/--server 'https:\/\/asp\.example:15183'/)).toBeInTheDocument();
    expect(screen.getAllByText(/<受信manifest散列>/).length).toBeGreaterThan(0);
    expect(screen.getByText(/共用同一个采集器/)).toBeInTheDocument();
  });

  it('三个系统页签切换命令；macOS 如实说明', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('B. 在终端安装探针');
    await user.click(screen.getByRole('tab', { name: 'Windows' }));
    expect(screen.getByText(/enterprise-install\.ps1 -Action install/)).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'macOS' }));
    expect(screen.getByText(/install-enterprise-macos\.py install/)).toBeInTheDocument();
    expect(screen.getByText(/联系管理员获取/)).toBeInTheDocument();
  });

  it('未配置平台地址时提示联系部署管理员（不再指向不存在的设置分区），命令用占位符', async () => {
    mocks.config.mockResolvedValue({ enabled: true, agentshieldBaseUrl: '' });
    renderPage();
    expect(
      await screen.findByText('智能体安全平台地址未配置，请联系部署管理员在部署配置中设置。'),
    ).toBeInTheDocument();
    // 平台设置里没有「智能体安全平台联动」分区：不再出现这条文案，也不再有跳转到设置页的链接
    expect(document.body).not.toHaveTextContent(/智能体安全平台联动/);
    expect(screen.queryByRole('link', { name: /平台设置/ })).not.toBeInTheDocument();
    expect(screen.getByText(/<智能体安全平台地址>/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /打开智能体安全平台/ })).not.toBeInTheDocument();
  });

  it('已接入终端列表：在线/离线、真机测评支持情况', async () => {
    renderPage();
    const row = (await screen.findByText('demo-host')).closest('tr')!;
    expect(within(row).getByText('在线')).toBeInTheDocument();
    expect(within(row).getByText(/Claude Code 2\.1\.126/)).toBeInTheDocument();
    expect(within(row).getByText(/支持（执行器 v1）/)).toBeInTheDocument();
    const row2 = screen.getByText('YJ40B4').closest('tr')!;
    expect(within(row2).getByText('离线')).toBeInTheDocument();
    expect(within(row2).getByText(/无测评执行器，仅可体检/)).toBeInTheDocument();
    // 无执行器的终端要给出路：重新运行安装包 / 一键命令
    const hint = screen.getByTestId('no-runner-hint');
    expect(hint).toHaveTextContent('重新运行安装包或一键命令');
    expect(hint).toHaveTextContent('Linux 一键命令已自带开启参数');
    expect(hint).toHaveTextContent('Windows 安装包会自动开启');
  });

  it('已装智能体去重，version_unknown 显示「版本未知」', async () => {
    mocks.endpoints.mockResolvedValue([
      {
        ...ENDPOINTS[0],
        agents: [
          { product: 'claude-code', version: '2.1.126', headless_capable: true },
          { product: 'claude-code', version: '2.1.126', headless_capable: true },
          { product: 'claude-code', version: '2.1.308', headless_capable: true },
          { product: 'codex', version: 'version_unknown', headless_capable: true },
        ],
      },
    ]);
    renderPage();
    const row = (await screen.findByText('demo-host')).closest('tr')!;
    expect(
      within(row).getByText('Claude Code 2.1.126、Claude Code 2.1.308、Codex 版本未知'),
    ).toBeInTheDocument();
    expect(row).not.toHaveTextContent('version_unknown');
  });

  it('列表加载失败的提示不再指向平台设置', async () => {
    mocks.endpoints.mockRejectedValue(new Error('x'));
    renderPage();
    expect(await screen.findByText(/终端列表加载失败/)).toBeInTheDocument();
    expect(document.body).toHaveTextContent('请联系部署管理员确认部署配置');
    expect(document.body).not.toHaveTextContent(/平台设置/);
    expect(screen.queryByRole('link', { name: /平台设置/ })).not.toBeInTheDocument();
  });

  it('真机测评不再出现审批措辞', async () => {
    renderPage();
    await screen.findByText('demo-host');
    expect(document.body).not.toHaveTextContent(/审批/);
  });

  it('空列表给出提示；失败显示原因与重试', async () => {
    mocks.endpoints.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('尚未发现已接入的终端')).toBeInTheDocument();
    expect(screen.getByText(/请展开下方「新终端：安装探针」/)).toBeInTheDocument();
    expect(screen.getByText(/请先在智能体安全平台确认它在线/)).toBeInTheDocument();
  });
  it('列表加载失败显示重试', async () => {
    mocks.endpoints.mockRejectedValue(new Error('x'));
    renderPage();
    expect(await screen.findByText(/终端列表加载失败/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  it('登记按钮跳到评估对象页并带预填信息（不直接创建）', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole('button', { name: /登记为评估对象：demo-host Claude Code/ }),
    );
    const state = JSON.parse((await screen.findByTestId('state')).textContent!);
    expect(state.registerEndpoint).toEqual({
      endpointId: 'a',
      hostname: 'demo-host',
      product: 'claude-code',
      name: 'demo-host 终端(Claude Code)',
    });
  });

  it('已登记的终端显示「已登记」，无创建权限时不显示登记按钮', async () => {
    mocks.list.mockResolvedValue({
      items: [
        {
          id: 't',
          name: 'x',
          targetType: 'ENDPOINT_AGENT',
          isActive: true,
          accessConfig: { endpointId: 'a', product: 'claude-code' },
        },
      ],
      total: 1,
      page: 1,
      pageSize: 100,
    });
    renderPage();
    expect(await screen.findByText('Claude Code 已登记')).toBeInTheDocument();
  });
  it('无新建权限只读展示', async () => {
    mocks.perms.mockImplementation((c: string) => c === 'eval_task:create');
    renderPage();
    await screen.findByText('demo-host');
    expect(screen.queryByRole('button', { name: /登记为评估对象：/ })).not.toBeInTheDocument();
  });

  it('测评未启用时提示联系管理员', async () => {
    mocks.config.mockResolvedValue({ enabled: false, agentshieldBaseUrl: '' });
    renderPage();
    expect(await screen.findByText(/尚未启用/)).toBeInTheDocument();
  });
});

describe('信息架构：复用优先，安装非必要', () => {
  it('终端列表在折叠安装区之前；折叠区默认关闭，展开后可见命令', async () => {
    const user = userEvent.setup();
    renderPage();
    const listTitle = await screen.findByText('已接入的终端（可直接复用）');
    const foldTitle = screen.getByText(/新终端：安装探针（仅当终端未接入时需要）/);
    expect(
      listTitle.compareDocumentPosition(foldTitle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText('通常不需要')).toBeInTheDocument();
    expect(
      screen.getByText('这些终端已由智能体安全平台接入，可直接登记为评估对象。'),
    ).toBeInTheDocument();
    const fold = screen.getByTestId('install-probe-fold') as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    // 页面第一个区块是终端列表，而不是创建接入码
    const headings = Array.from(document.querySelectorAll('h2,h3')).map((h) => h.textContent);
    expect(headings.findIndex((t) => t?.includes('已接入的终端'))).toBeLessThan(
      headings.findIndex((t) => t?.includes('创建接入码')),
    );
    await user.click(screen.getByText('展开安装步骤'));
    expect(fold.open).toBe(true);
    expect(screen.getByText(/install-enterprise-linux\.sh install/)).toBeVisible();
  });

  it('页面内不出现必要条件措辞', async () => {
    renderPage();
    await screen.findByText('demo-host');
    const text = document.body.textContent ?? '';
    for (const bad of ['才能对其做配置体检', '必须先', '后，才能', '步骤 1', '步骤 2', '步骤 3']) {
      expect(text).not.toContain(bad);
    }
    expect(text).toContain('无需重复安装');
  });
});

describe('自管终端提示卡', () => {
  it('fleet 未启用或接口不存在时不显示', async () => {
    renderPage();
    await screen.findByText('demo-host');
    expect(screen.queryByTestId('fleet-hint')).not.toBeInTheDocument();
    expect(screen.queryByText(/没有智能体安全平台/)).not.toBeInTheDocument();
  });

  it('fleet 已启用时显示提示卡，按钮跳到 /fleet', async () => {
    mocks.fleetConfig.mockResolvedValue({ enabled: true });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText(/没有智能体安全平台？可用鉴盾自管终端接入/)).toBeInTheDocument();
    expect(screen.getByTestId('fleet-hint')).toHaveTextContent('在「终端」页即可完成接入码');
    await user.click(screen.getByRole('button', { name: '前往自管终端' }));
    expect(await screen.findByText('终端页')).toBeInTheDocument();
  });

  it('fleet 返回 enabled=false 时不显示', async () => {
    mocks.fleetConfig.mockResolvedValue({ enabled: false });
    renderPage();
    await screen.findByText('demo-host');
    expect(screen.queryByTestId('fleet-hint')).not.toBeInTheDocument();
  });
});

describe('buildInstallCommands', () => {
  it('HTTP 地址追加允许 HTTP 参数', () => {
    expect(buildInstallCommands('http://10.0.0.1:15181', 'linux')[0]!.command).toContain(
      '--allow-http',
    );
    expect(buildInstallCommands('https://a', 'linux')[0]!.command).not.toContain('--allow-http');
  });
});
