import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { overviewFixture } from '@/components/fleet/endpoint-overview.test-data';
import { CHECK_CATALOG } from '@/components/fleet/check-catalog.test-data';
import { MOCK_ENDPOINTS } from './fleet/__mocks__/data';
import { providerLabel } from './ModelTargetsPage';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import { ModelTargetsPage } from './ModelTargetsPage';
const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  posture: vi.fn(),
  run: vi.fn(),
  fleetEndpoint: vi.fn(),
  checkCatalog: vi.fn(),
  overview: vi.fn(),
  requestEvalJob: vi.fn(),
  fleetPostureEval: vi.fn(),
  endpointsList: vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  ApiError: class extends Error {},
  api: {
    modelTargets: { list: mocks.list, get: mocks.get, create: mocks.create },
    fleet: {
      checkCatalog: mocks.checkCatalog,
      overview: mocks.overview,
      requestEvalJob: mocks.requestEvalJob,
      endpoint: mocks.fleetEndpoint,
      postureEval: mocks.fleetPostureEval,
    },
    systemSettings: { get: async () => ({ gateway: { gatewayBaseUrl: '' } }) },
    endpointEvals: {
      config: mocks.config,
      posture: mocks.posture,
      run: mocks.run,
      endpoints: (...args: unknown[]) => mocks.endpointsList(...args),
    },
  },
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ hasPermission: () => true }) }));
function WizardLocation() { return <div>测评向导 {useLocation().search}</div>; }
function renderPage(entry = '/') {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ToastProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/" element={<ModelTargetsPage />} />
            <Route path="/model-targets" element={<ModelTargetsPage />} />
            <Route path="/eval-tasks/:id" element={<div>任务详情页</div>} />
            <Route path="/fleet" element={<div>终端页</div>} />
            <Route path="/agent-evals/new" element={<WizardLocation />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkCatalog.mockResolvedValue(CHECK_CATALOG);
  mocks.overview.mockResolvedValue({ ...overviewFixture, endpointId: "uuid-1", agents: [overviewFixture.agents[0]] });
  mocks.fleetEndpoint.mockResolvedValue({
    ...MOCK_ENDPOINTS[0],
    id: 'uuid-1',
    agents: [
      {
        product: 'claude-code',
        version: '2.1.0',
        liveEvalRegistered: true,
        liveEvalSupported: true,
      },
    ],
  });
  mocks.endpointsList.mockResolvedValue([
    {
      endpoint_id: 'e',
      hostname: '研发电脑',
      os: 'linux',
      eval_runner_version: '1',
      agents: [{ product: 'claude-code', headless_capable: true }],
    },
  ]);
  mocks.config.mockResolvedValue({ enabled: true, agentshieldBaseUrl: 'https://asp.example' });
  mocks.list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 });
  mocks.create.mockResolvedValue({ id: 'saved' });
});
it('开关开启后可选择终端并以契约字段保存，不显示 API 密钥', async () => {
  renderPage();
  await screen.findByText('评估对象');
  await userEvent.click(screen.getByRole('button', { name: /新建评估对象/ }));
  await screen.findByRole('option', { name: '终端智能体' });
  await userEvent.selectOptions(screen.getByLabelText('对象类型'), 'ENDPOINT_AGENT');
  await userEvent.type(screen.getByLabelText(/^名称/), '研发终端');
  await screen.findByRole('option', { name: '研发电脑' });
  await userEvent.selectOptions(screen.getByLabelText('终端'), 'e');
  expect(screen.queryByLabelText(/API Key/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /^保存$/ }));
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({
      targetType: 'ENDPOINT_AGENT',
      accessConfig: {
        agentshieldBaseUrl: 'https://asp.example',
        endpointId: 'e',
        product: 'claude-code',
        endpointLabel: '研发电脑',
      },
    }),
  );
});
it('默认关闭隐藏终端类型和操作入口', async () => {
  mocks.config.mockResolvedValue({ enabled: false });
  renderPage();
  await screen.findByText('评估对象');
  await userEvent.click(screen.getByRole('button', { name: /新建评估对象/ }));
  expect(screen.queryByRole('option', { name: '终端智能体' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '配置体检' })).not.toBeInTheDocument();
});
it('终端对象显示中文类型及两个操作', async () => {
  mocks.list.mockResolvedValue({
    items: [
      {
        id: 'target',
        name: '员工终端',
        targetType: 'ENDPOINT_AGENT',
        provider: 'agentshield',
        model: 'endpoint-agent',
        baseUrl: 'https://asp.example',
        accessConfig: { endpointId: 'e' },
        isActive: true,
      },
    ],
    total: 1,
    page: 1,
    pageSize: 10,
  });
  renderPage();
  await screen.findByText('员工终端');
  expect(await screen.findByRole('button', { name: '配置体检' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '更多' }));
  // 真机测评就叫「真机测评」，不再带「需终端管理员审批」
  expect(screen.getByRole('menuitem', { name: '真机测评' })).toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: /审批/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: 'AIBOM' })).not.toBeInTheDocument();
  expect(screen.getAllByText('终端智能体').length).toBeGreaterThan(0);
  // 副标题 provider 走中文映射，不露 agentshield
  expect(screen.getByText('智能体安全平台')).toBeInTheDocument();
  expect(screen.queryByText('agentshield')).not.toBeInTheDocument();
});
it('顶部「接入终端」按钮进入终端页的「接入终端」页签（旧的接入页路由仅作兼容，不再是入口）', async () => {
  function FleetProbe() {
    const { pathname, search } = useLocation();
    return <div>终端页 {pathname + search}</div>;
  }
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ToastProvider>
        <MemoryRouter initialEntries={['/model-targets']}>
          <Routes>
            <Route path="/model-targets" element={<ModelTargetsPage />} />
            <Route path="/fleet" element={<FleetProbe />} />
            <Route
              path="/model-targets/endpoint-onboarding"
              element={<div>旧接入页（不应从入口到达）</div>}
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: '接入终端' }));
  expect(await screen.findByText('终端页 /fleet?tab=enroll')).toBeInTheDocument();
  expect(screen.queryByText('旧接入页（不应从入口到达）')).not.toBeInTheDocument();
});

const fleetTarget = {
  id: 'fleet-target',
  name: 'demo-host（Linux）',
  targetType: 'ENDPOINT_AGENT',
  provider: 'jiandun-fleet',
  model: 'endpoint-agent',
  baseUrl: 'fleet://ep_b63c2fe6363d0b502894',
  accessConfig: {
    source: 'jiandun-fleet',
    fleetEndpointId: 'uuid-1',
    endpointId: 'ep_b63c2fe6363d0b502894',
    endpointLabel: 'demo-host',
  },
  isActive: true,
  isGlobal: true,
  lastTestStatus: null,
};

describe('provider 中文名映射', () => {
  it.each([
    ['jiandun-fleet', '鉴盾自管终端'],
    ['agentshield', '智能体安全平台'],
    ['openai-compatible', 'OpenAI 兼容接口'],
    ['something-new', '其他'],
    ['', '其他'],
    [undefined, '其他'],
  ])('%s → %s', (provider, label) => {
    expect(providerLabel(provider as string | undefined)).toBe(label);
  });
});

it('自管终端对象：副标题用中文名，详情显示主机名/系统/探针状态，不露内部编号和 fleet://', async () => {
  mocks.list.mockResolvedValue({ items: [fleetTarget], total: 1, page: 1, pageSize: 10 });
  mocks.fleetEndpoint.mockResolvedValue({
    id: 'uuid-1',
    hostname: 'demo-host',
    os: 'linux',
    osVersion: 'Ubuntu 24.04',
    agentVersion: '50ba8d3a9a01c1fe02541ba98f89f2a5ccc992b9',
    status: 'ACTIVE',
    online: true,
  });
  renderPage();
  await screen.findByText('demo-host（Linux）');
  expect(screen.getByText('鉴盾自管终端')).toBeInTheDocument();
  expect(screen.queryByText('jiandun-fleet')).not.toBeInTheDocument();
  await userEvent.click(screen.getByText('接入详情'));
  const details = await screen.findByTestId('endpoint-target-details');
  await screen.findByText('Linux Ubuntu 24.04');
  expect(details).toHaveTextContent('主机名');
  expect(details).toHaveTextContent('demo-host');
  expect(details).toHaveTextContent('在线 · 版本 50ba8d3a');
  expect(details).not.toHaveTextContent('对象标识');
  expect(details).not.toHaveTextContent('接入位置');
  expect(details).not.toHaveTextContent('endpoint-agent');
  expect(document.body).not.toHaveTextContent('fleet://');
  expect(document.body).not.toHaveTextContent(/ep_[0-9a-f]{20}/);
});

it('旧格式的自管终端对象名在界面上先去掉终端编号', async () => {
  mocks.list.mockResolvedValue({
    items: [{ ...fleetTarget, name: '自管终端 demo-host（ep_b63c2fe6363d0b502894）' }],
    total: 1,
    page: 1,
    pageSize: 10,
  });
  renderPage();
  // 名称列显示去掉编号后的主机名（悬停提示同步）
  const name = await screen.findByTitle('demo-host');
  expect(name).toHaveTextContent('demo-host');
  expect(document.body).not.toHaveTextContent('ep_b63c');
  expect(document.body).not.toHaveTextContent('自管终端 demo-host');
});

it('操作列留在 1280 宽的视口内：表格不再要求 1040px，名称列不设死宽度', async () => {
  mocks.list.mockResolvedValue({ items: [fleetTarget], total: 1, page: 1, pageSize: 10 });
  renderPage();
  const table = await screen.findByRole('table', { name: '评估对象列表' });
  expect(table.className).not.toContain('min-w-[1040px]');
  const widths = Array.from(table.querySelectorAll('th'))
    .map((th) => th.className.match(/w-\[(\d+)px\]/)?.[1])
    .filter(Boolean)
    .map(Number);
  // 固定宽度列合计要给名称列留出空间（1280 宽下内容区约 980）
  expect(widths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(480);
});

it('自管终端对象的配置体检走 /fleet 接口并跳到任务页', async () => {
  mocks.list.mockResolvedValue({ items: [fleetTarget], total: 1, page: 1, pageSize: 10 });
  mocks.fleetPostureEval.mockResolvedValue({ taskId: 'task-1', status: 'COMPLETED' });
  renderPage();
  await userEvent.click(await screen.findByRole('button', { name: '配置体检' }));
  await userEvent.click(await screen.findByRole('button', { name: '开始检测' }));
  expect(await screen.findByText('任务详情页')).toBeInTheDocument();
  expect(mocks.fleetPostureEval).toHaveBeenCalledWith('uuid-1', { items: ['permissions'] });
  expect(mocks.posture).not.toHaveBeenCalled();
});

it('自管终端对象进入预选终端的测评向导', async () => {
  mocks.list.mockResolvedValue({ items: [fleetTarget], total: 1, page: 1, pageSize: 10 });
  renderPage();
  await userEvent.click(await screen.findByRole('button', { name: '更多' }));
  await userEvent.click(screen.getByRole('menuitem', { name: '真机测评' }));
  expect(await screen.findByText('测评向导 ?endpoint=uuid-1')).toBeInTheDocument();
  expect(mocks.requestEvalJob).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
});

describe('?untested=1：首页「测试」按钮的跳转', () => {
  const model = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: `对象-${id}`,
    targetType: 'MODEL',
    provider: 'openai-compatible',
    model: 'm',
    baseUrl: 'http://x/v1',
    accessConfig: null,
    isActive: true,
    isGlobal: true,
    lastTestStatus: null,
    ...extra,
  });
  const items = [
    model('plain'),
    model('tested', { lastTestStatus: 'SUCCESS' }),
    model('agent', { targetType: 'AGENT_API' }),
    fleetTarget,
    model('gateway', { targetType: 'GATEWAY_LOG' }),
  ];

  it('只显示未测试且可连通性测试的对象，并提示可以显示全部', async () => {
    mocks.list.mockResolvedValue({ items, total: items.length, page: 1, pageSize: 10 });
    renderPage('/model-targets?untested=1');
    await screen.findByText('对象-plain');
    expect(screen.getByText('对象-agent')).toBeInTheDocument();
    expect(screen.queryByText('对象-tested')).not.toBeInTheDocument();
    expect(screen.queryByText('demo-host（Linux）')).not.toBeInTheDocument();
    expect(screen.queryByText('对象-gateway')).not.toBeInTheDocument();
    expect(screen.getByTestId('untested-filter')).toHaveTextContent('只显示「未测试」的对象');
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ untested: true }));
  });

  it('点「显示全部对象」去掉过滤', async () => {
    mocks.list.mockResolvedValue({ items, total: items.length, page: 1, pageSize: 10 });
    renderPage('/model-targets?untested=1');
    await screen.findByText('对象-plain');
    await userEvent.click(screen.getByRole('button', { name: '显示全部对象' }));
    expect(await screen.findByText('对象-tested')).toBeInTheDocument();
    expect(screen.queryByTestId('untested-filter')).not.toBeInTheDocument();
  });

  it('没有 untested 参数时不过滤、不带参数', async () => {
    mocks.list.mockResolvedValue({ items, total: items.length, page: 1, pageSize: 10 });
    renderPage('/model-targets');
    await screen.findByText('对象-tested');
    expect(screen.queryByTestId('untested-filter')).not.toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledWith(expect.not.objectContaining({ untested: true }));
  });
});

it('旧连接器未提供登记与风险选择能力时不能绕过影响确认启动真机', async () => {
  mocks.list.mockResolvedValue({
    items: [
      {
        ...fleetTarget,
        provider: 'agentshield',
        accessConfig: { endpointId: 'e', product: 'claude-code' },
      },
    ],
    total: 1,
    page: 1,
    pageSize: 10,
  });
  mocks.get.mockResolvedValue({
    ...fleetTarget,
    provider: 'agentshield',
    accessConfig: { endpointId: 'e', product: 'claude-code' },
  });
  renderPage();
  await userEvent.click(await screen.findByRole('button', { name: '更多' }));
  await userEvent.click(screen.getByRole('menuitem', { name: '真机测评' }));
  expect(await screen.findByText(/旧连接器尚未提供智能体登记和风险范围选择/)).toBeInTheDocument();
  expect(mocks.run).not.toHaveBeenCalled();
});

it('绑定的终端已失效的对象在名称旁标出「终端已失效」，判断不了的不显示任何东西', async () => {
  const target = (id: string, name: string, endpointState?: string) => ({
    id, name, targetType: 'ENDPOINT_AGENT', provider: 'agentshield', model: 'endpoint-agent', baseUrl: 'https://asp.example',
    accessConfig: { endpointId: id }, isActive: true, ...(endpointState ? { endpointState } : {}) });
  mocks.list.mockResolvedValue({
    items: [target('gone', '已吊销的终端', 'gone'), target('unknown', '查不到的终端', 'unknown'), target('active', '在用的终端', 'active')],
    total: 3, page: 1, pageSize: 10,
  });
  renderPage();
  const gone = (await screen.findByText('已吊销的终端')).closest('tr')!;
  // 终端状态要问智能体安全平台，只有本页的列表请求明确要。
  expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ withEndpointState: true }));
  expect(within(gone).getByText('终端已失效')).toBeInTheDocument();
  expect(screen.getAllByText('终端已失效')).toHaveLength(1);
});
