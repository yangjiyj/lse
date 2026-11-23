import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import { AssetDiscoveryPage } from './AssetDiscoveryPage';

const perms = new Set<string>();
const auth: { user: unknown } = { user: undefined };
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: (c: string) => perms.has(c), user: auth.user }),
}));

const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  saveScope: vi.fn(),
  runs: vi.fn(),
  run: vi.fn(),
  startRun: vi.fn(),
  gatewayClues: vi.fn(),
  createTarget: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  assetDiscoveryApi: {
    scope: mocks.scope,
    saveScope: mocks.saveScope,
    runs: mocks.runs,
    run: mocks.run,
    startRun: mocks.startRun,
    gatewayClues: mocks.gatewayClues,
  },
  api: { modelTargets: { create: mocks.createTarget } },
}));

const RUN = {
  id: 'r1',
  status: 'COMPLETED',
  targets: ['127.0.0.1'],
  ports: [11434],
  hostCount: 1,
  portCount: 2,
  endpointCount: 3,
  probedCount: 1,
  hitCount: 1,
  error: null,
  createdByName: 'admin',
  startedAt: null,
  finishedAt: null,
  createdAt: '2026-09-29T00:00:00.000Z',
};

function renderPage(initialEntry = '/inspect/asset-discovery') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <AssetDiscoveryPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  perms.clear();
  for (const p of [
    'engine:scan',
    'platform_setting:update',
    'model_target:create',
    'gateway_log:analyze',
  ])
    perms.add(p);
  mocks.scope.mockResolvedValue({ entries: ['127.0.0.1/32'], ports: [11434], maxHostsPerRun: 64 });
  mocks.runs.mockResolvedValue([RUN]);
  mocks.run.mockResolvedValue({
    ...RUN,
    hits: [
      {
        id: 'h1',
        host: '127.0.0.1',
        port: 11434,
        baseUrl: 'http://127.0.0.1:11434/v1',
        serviceType: 'OLLAMA',
        models: ['qwen2.5:7b', 'llama3:8b'],
        modelDetails: [
          {
            name: 'qwen2.5:7b',
            family: 'qwen2',
            parameterSize: '7.6B',
            quantization: 'Q4_K_M',
            contextLength: 32768,
          },
          { name: 'llama3:8b', family: 'llama' },
        ],
        evidence: 'GET /api/tags',
        matches: [
          { model: 'qwen2.5:7b', registered: false, targetId: null, targetName: null },
          { model: 'llama3:8b', registered: false, targetId: null, targetName: null },
        ],
      },
    ],
  });
  mocks.startRun.mockResolvedValue({ ...RUN, id: 'r2', status: 'PENDING' });
  mocks.createTarget.mockResolvedValue({ id: 't1' });
});

describe('AssetDiscoveryPage', () => {
  it('地址带 ?run= 时直接打开这次测绘', async () => {
    renderPage('/inspect/asset-discovery?run=r9');
    await waitFor(() => expect(mocks.run).toHaveBeenCalledWith('r9'));
  });

  it('结果表标出未登记 AI 服务，可一键登记为评估对象', async () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'AI 资产测绘' })).toBeInTheDocument();
    const row = (await screen.findAllByText('http://127.0.0.1:11434/v1'))[0]!.closest('tr')!;
    expect(within(row).getByText('Ollama')).toBeInTheDocument();
    expect(within(row).getByText('未登记 AI 服务')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: '登记为评估对象' }));
    expect(screen.getByLabelText(/接口地址/)).toHaveValue('http://127.0.0.1:11434/v1');
    expect(screen.getByLabelText(/模型标识/)).toHaveValue('qwen2.5:7b');
    fireEvent.click(screen.getByRole('button', { name: '确认登记' }));
    await waitFor(() => expect(mocks.createTarget).toHaveBeenCalled());
    expect(mocks.createTarget.mock.calls[0]![0]).toMatchObject({
      targetType: 'MODEL',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5:7b',
    });
  });

  it('每个服务可展开查看模型配置，拿不到的字段显示为 —', async () => {
    renderPage();
    const toggle = await screen.findByRole('button', { name: '模型配置' });
    expect(screen.getAllByRole('button', { name: '模型配置' })).toHaveLength(1);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('columnheader', { name: '上下文长度' })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const table = screen.getByRole('columnheader', { name: '上下文长度' }).closest('table')!;
    const qwen = within(table).getByText('qwen2.5:7b').closest('tr')!;
    for (const text of ['qwen2', '7.6B', 'Q4_K_M', '32768']) {
      expect(within(qwen).getByText(text)).toBeInTheDocument();
    }
    const llama = within(table).getByText('llama3:8b').closest('tr')!;
    expect(within(llama).getAllByText('—')).toHaveLength(3);
    fireEvent.click(toggle);
    expect(screen.queryByRole('columnheader', { name: '上下文长度' })).toBeNull();
  });

  it('扫描记录显示实际端点数，不再显示主机数 × 端口数', async () => {
    renderPage();
    const header = await screen.findByRole('columnheader', { name: '端点数' });
    const table = header.closest('table')!;
    expect(within(table).queryByRole('columnheader', { name: '主机 × 端口' })).toBeNull();
    const row = within(table).getByText('admin').closest('tr')!;
    expect(within(row).getByText('3')).toBeInTheDocument();
    expect(within(row).queryByText(/×/)).toBeNull();
  });

  it('TGI 的 model_dtype 显示在「精度」列，量化留空', async () => {
    mocks.run.mockResolvedValue({
      ...RUN,
      hits: [
        {
          id: 'h-tgi',
          host: '127.0.0.1',
          port: 8080,
          baseUrl: 'http://127.0.0.1:8080/v1',
          serviceType: 'TGI',
          models: ['bigscience/bloom-560m'],
          modelDetails: [
            { name: 'bigscience/bloom-560m', dtype: 'torch.float16', contextLength: 4095 },
          ],
          evidence: 'GET /info',
          matches: [
            { model: 'bigscience/bloom-560m', registered: false, targetId: null, targetName: null },
          ],
        },
      ],
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '模型配置' }));
    const table = screen.getByRole('columnheader', { name: '精度' }).closest('table')!;
    const row = within(table).getByText('bigscience/bloom-560m').closest('tr')!;
    const cells = within(row).getAllByRole('cell');
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(cells[headers.indexOf('精度')]).toHaveTextContent('torch.float16');
    expect(cells[headers.indexOf('量化')]).toHaveTextContent('—');
  });

  it('没有返回「精度」的服务不显示精度列', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '模型配置' }));
    expect(screen.getByRole('columnheader', { name: '量化' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: '精度' })).toBeNull();
  });

  it('只有模型名、没有其他配置字段时（如 Triton）不显示展开按钮', async () => {
    mocks.run.mockResolvedValue({
      ...RUN,
      hits: [
        {
          id: 'h-triton',
          host: '127.0.0.1',
          port: 8001,
          baseUrl: 'http://127.0.0.1:8001',
          serviceType: 'TRITON',
          models: ['ensemble_llm'],
          modelDetails: [{ name: 'ensemble_llm' }],
          evidence: 'GET /v2',
          matches: [{ model: 'ensemble_llm', registered: false, targetId: null, targetName: null }],
        },
      ],
    });
    renderPage();
    await screen.findByText('http://127.0.0.1:8001');
    expect(screen.queryByRole('button', { name: '模型配置' })).toBeNull();
  });

  it('旧记录没有模型配置时不显示展开按钮', async () => {
    mocks.run.mockResolvedValue({
      ...RUN,
      hits: [
        {
          id: 'h0',
          host: '127.0.0.1',
          port: 8000,
          baseUrl: 'http://127.0.0.1:8000/v1',
          serviceType: 'VLLM',
          models: ['m'],
          modelDetails: null,
          evidence: 'GET /v1/models',
          matches: [{ model: 'm', registered: false, targetId: null, targetName: null }],
        },
      ],
    });
    renderPage();
    await screen.findByText('http://127.0.0.1:8000/v1');
    expect(screen.queryByRole('button', { name: '模型配置' })).toBeNull();
  });

  it('发起扫描前弹窗写明主机数×端口数，确认后带 confirm:true', async () => {
    renderPage();
    await screen.findAllByText('http://127.0.0.1:11434/v1');
    fireEvent.change(screen.getByLabelText('扫描目标'), { target: { value: '127.0.0.0/30' } });
    fireEvent.change(screen.getByLabelText('扫描端口'), { target: { value: '11434, 8000' } });
    fireEvent.click(screen.getByRole('button', { name: '发起扫描' }));
    expect(screen.getByText(/将主动探测/).textContent).toMatch(
      /4\s*台主机 ×\s*2\s*个端口（共\s*8\s*个端点）/,
    );
    fireEvent.click(screen.getByRole('button', { name: '确认扫描' }));
    await waitFor(() =>
      expect(mocks.startRun).toHaveBeenCalledWith({
        targets: ['127.0.0.0/30'],
        ports: [11434, 8000],
        confirm: true,
      }),
    );
  });

  it('扫描目标可填 URL，只填 URL 时端口取自 URL', async () => {
    renderPage();
    await screen.findAllByText('http://127.0.0.1:11434/v1');
    expect(screen.getByText(/可填 IP、CIDR、主机名、主机:端口或 URL/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('扫描目标'), {
      target: { value: 'http://127.0.0.1:11434, https://llm.example.com/v1' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发起扫描' }));
    expect(screen.getByText(/将主动探测/).textContent).toMatch(/将主动探测\s*2\s*个端点/);
    fireEvent.click(screen.getByRole('button', { name: '确认扫描' }));
    await waitFor(() =>
      expect(mocks.startRun).toHaveBeenCalledWith({
        targets: ['http://127.0.0.1:11434', 'https://llm.example.com/v1'],
        ports: [],
        confirm: true,
      }),
    );
  });

  it('「主机:端口」按单个端点确认，不需要另填端口', async () => {
    renderPage();
    await screen.findAllByText('http://127.0.0.1:11434/v1');
    fireEvent.change(screen.getByLabelText('扫描目标'), { target: { value: '127.0.0.1:11434' } });
    fireEvent.click(screen.getByRole('button', { name: '发起扫描' }));
    expect(screen.getByText(/将主动探测/).textContent).toMatch(/将主动探测\s*1\s*个端点/);
    fireEvent.click(screen.getByRole('button', { name: '确认扫描' }));
    await waitFor(() =>
      expect(mocks.startRun).toHaveBeenCalledWith({
        targets: ['127.0.0.1:11434'],
        ports: [],
        confirm: true,
      }),
    );
  });

  it('URL 与 IP 混填时按端点数确认', async () => {
    renderPage();
    await screen.findAllByText('http://127.0.0.1:11434/v1');
    fireEvent.change(screen.getByLabelText('扫描目标'), {
      target: { value: '127.0.0.0/31, http://127.0.0.1:8000/v1' },
    });
    fireEvent.change(screen.getByLabelText('扫描端口'), { target: { value: '11434, 8000' } });
    fireEvent.click(screen.getByRole('button', { name: '发起扫描' }));
    expect(screen.getByText(/将主动探测/).textContent).toMatch(/将主动探测\s*5\s*个端点/);
  });

  it('未配置范围时禁用发起扫描', async () => {
    mocks.scope.mockResolvedValue({ entries: [], ports: [], maxHostsPerRun: 64 });
    mocks.runs.mockResolvedValue([]);
    renderPage();
    // 管理员本人看到的是可操作的提示，且这句话只出现一处
    expect(await screen.findByText('尚未配置扫描范围，请先在上方填写并保存。')).toBeInTheDocument();
    expect(screen.queryByText(/管理员尚未配置/)).toBeNull();
    expect(screen.getAllByText(/默认不扫描任何地址/)).toHaveLength(1);
    expect(screen.getByRole('button', { name: '发起扫描' })).toBeDisabled();
    expect(screen.getAllByText('暂无数据').length).toBeGreaterThan(0);
  });

  it('未配置范围且非管理员：提示联系平台管理员，不让其去“上方填写”', async () => {
    perms.delete('platform_setting:update');
    mocks.scope.mockResolvedValue({ entries: [], ports: [], maxHostsPerRun: 64 });
    mocks.runs.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('尚未配置扫描范围，请联系平台管理员配置。')).toBeInTheDocument();
    expect(screen.queryByText(/请先在上方填写并保存/)).toBeNull();
    expect(screen.getAllByText(/默认不扫描任何地址/)).toHaveLength(1);
  });

  it('非管理员不可编辑范围', async () => {
    perms.delete('platform_setting:update');
    renderPage();
    expect(await screen.findByText('仅平台管理员可修改扫描范围。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '保存范围' })).toBeNull();
  });

  it('非平台租户：没有网关审计线索页签，也不请求网关线索', async () => {
    auth.user = { tenant: { id: 't-a', name: '甲单位', isPlatform: false } };
    try {
      renderPage();
      expect(await screen.findByText('AI 资产测绘')).toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: '网关审计线索' })).toBeNull();
      expect(mocks.gatewayClues).not.toHaveBeenCalled();
    } finally {
      auth.user = undefined;
    }
  });

  it('网关线索页签：未接入显示受限状态', async () => {
    mocks.gatewayClues.mockResolvedValue({
      status: 'NOT_CONNECTED',
      message: '网关未接入，无法获取审计线索',
      clues: [],
    });
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: '网关审计线索' }));
    expect(await screen.findByText('网关未接入，无法获取审计线索')).toBeInTheDocument();
  });

  it('网关线索页签：列出上游模型并标出未登记', async () => {
    mocks.gatewayClues.mockResolvedValue({
      status: 'OK',
      windowDays: 7,
      eventCount: 3,
      truncated: false,
      clues: [
        {
          model: 'shadow-upstream',
          providerId: 'p1',
          endpointTypes: ['chat_completions'],
          eventCount: 3,
          lastSeenAt: '2026-09-28T03:00:00Z',
          registered: false,
          targetId: null,
          targetName: null,
        },
      ],
    });
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: '网关审计线索' }));
    const row = (await screen.findByText('shadow-upstream')).closest('tr')!;
    expect(within(row).getByText('未登记 AI 服务')).toBeInTheDocument();
    expect(within(row).getByText('3')).toBeInTheDocument();
  });
});
