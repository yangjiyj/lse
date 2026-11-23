import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppProfile, DetectRiskCategoryStat, RiskCount } from '@/lib/detect-risks';
import { AppProfilePage, acceleratorModel } from './AppProfilePage';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@/lib/detect-risks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/detect-risks')>()),
  appProfilesApi: { get: mocks.get, list: vi.fn() },
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ hasPermission: () => true }) }));

const count = (total: number, high = 0): RiskCount => ({
  total,
  high,
  bySeverity: { CRITICAL: 0, HIGH: high, MEDIUM: total - high, LOW: 0, INFO: 0, UNRATED: 0 },
});
const stat = (
  category: DetectRiskCategoryStat['category'],
  label: string,
  sources: DetectRiskCategoryStat['sources'],
): DetectRiskCategoryStat => ({
  category,
  label,
  total: sources.reduce((s, x) => s + (x.count?.total ?? 0), 0),
  high: sources.reduce((s, x) => s + (x.count?.high ?? 0), 0),
  sources,
});

const card = (index: number) => ({
  vendor: 'nvidia',
  model: 'NVIDIA A100 80GB',
  memoryMB: 81920,
  driverVersion: '550.54',
  index,
  source: 'nvidia-smi',
  serverName: '推理服务器',
});

const hardware = {
  collectedAt: null,
  os: 'linux',
  osVersion: null,
  platform: 'ubuntu',
  platformVersion: '22.04',
  kernelVersion: null,
  arch: 'x86_64',
  cpuModel: 'Xeon',
  cpuCores: 32,
  cpuCountLogical: 64,
  memoryTotalMB: 524288,
  disks: null,
  accelerators: [card(0), card(1)],
  acceleratorErrors: null,
  aiComponents: [
    { id: 'vllm', name: 'vLLM', category: 'inference', version: '0.6.3', source: 'python_package' },
  ],
  aiComponentErrors: null,
};

const profile: AppProfile = {
  asset: {
    id: 'p-1',
    tenantId: 't',
    name: '客服智能体平台',
    code: 'APP-001',
    description: '',
    ownerName: '张三',
    ownerDepartment: '信息部',
    organizationPath: '集团 / 信息部',
    attrs: { url: 'https://agent.example.test', environment: 'prod' },
    modelTarget: { id: 'mt-1', name: '客服智能体', model: 'agent', targetType: 'AGENT' },
  },
  environment: {
    servers: [
      {
        assetId: 's-1',
        name: '推理服务器',
        type: 'server',
        ip: '10.0.0.5',
        os: 'ubuntu 22.04',
        cpu: 'Xeon · 32 核',
        memoryMB: 524288,
        gpu: 'NVIDIA A100 80GB × 2',
        endpoint: { id: 'e-1', hostname: 'gpu-node-01', lastSeenAt: '2026-11-22T01:00:00.000Z' },
        hardware,
      },
      {
        assetId: 's-2',
        name: '应用服务器',
        type: 'server',
        ip: '10.0.0.6',
        os: 'CentOS 7.9',
        cpu: 'Intel Xeon 8358',
        memoryMB: 262144,
        gpu: null,
        endpoint: null,
        hardware: null,
      },
    ],
    software: [{ assetId: 'sw-1', name: 'Nginx', vendor: 'F5', version: '1.25' }],
    components: [{ assetId: 'c-1', name: 'MCP 服务', componentType: 'mcp', version: '1.2.0' }],
    frameworks: hardware.aiComponents,
  },
  compute: { accelerators: [card(0), card(1)], cardCount: 2, totalMemoryMB: 163840 },
  models: [
    {
      assetId: 'm-1',
      name: '客服模型',
      modelTarget: { id: 'mt-2', name: '客服模型', model: 'qwen2-7b' },
      identity: {
        verdictLabel: '原始（官方指令版）',
        name: 'Qwen2-7B-Instruct',
        quantization: 'BF16',
        baseModel: 'Qwen/Qwen2-7B',
        knownModel: 'Qwen/Qwen2-7B-Instruct',
      },
      lastEval: { taskId: 'task-1', finishedAt: '2026-11-21T08:00:00.000Z', score: 82 },
      baseModel: 'Qwen/Qwen2-7B',
    },
    {
      assetId: 'm-2',
      name: '向量模型',
      modelTarget: null,
      identity: null,
      lastEval: null,
      baseModel: 'BGE-M3（台账）',
    },
  ],
  risks: {
    stats: {
      truncatedCorpusScans: 0,
      discoveryRunsTruncated: false,
      categories: [
        stat('model', '模型安全', [
          { source: 'model_file', label: '模型文件扫描发现', count: count(0) },
        ]),
        stat('data', '数据安全', [{ source: 'corpus', label: '语料扫描命中', count: count(2) }]),
        stat('content', '内容安全', [
          { source: 'eval_content', label: '内容评估风险项', count: count(2, 1) },
        ]),
        stat('app_env', '应用与环境安全', [
          { source: 'eval_app', label: '智能体与终端测评风险项', count: count(1, 1) },
          { source: 'ai_component', label: '组件扫描发现', count: count(1, 1) },
          { source: 'asset_discovery', label: '未登记 AI 服务', count: null },
        ]),
      ],
    },
    top: [
      {
        source: 'eval_content',
        id: 'f-1',
        tenantId: 't',
        title: '越狱',
        severity: 'CRITICAL',
        subject: '客服模型',
        recordKind: 'eval_task',
        recordId: 'task-1',
        recordName: '客服模型评估',
        href: '/eval-tasks/task-1',
        createdAt: '2026-11-21T08:00:00.000Z',
      },
    ],
  },
  suggestions: [
    {
      category: 'content',
      source: 'eval_content',
      title: '越狱与提示注入',
      action: '在网关拦截越狱模板',
      count: 2,
      severity: 'CRITICAL',
    },
    {
      category: 'app_env',
      source: 'ai_component',
      title: '工具描述含隐藏指令',
      action: '移除隐藏指令后重新发布',
      count: 1,
      severity: 'HIGH',
    },
    {
      category: 'data',
      source: 'corpus',
      title: '敏感信息',
      action: '用打码副本替换原语料',
      count: 2,
      severity: 'MEDIUM',
    },
  ],
  truncated: false,
};

function Probe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/analysis/profiles/p-1']}>
        <Routes>
          <Route path="/analysis/profiles/:assetId" element={<AppProfilePage />} />
          <Route path="*" element={<Probe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AppProfilePage 受测应用安全画像（2.5.6）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockResolvedValue(profile);
  });

  it('六块都在；基础信息带访问地址和环境', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: '客服智能体平台' })).toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledWith('p-1');
    for (const title of ['基础信息', '环境', '算力', '模型', '风险', '处置建议']) {
      expect(screen.getByRole('region', { name: title })).toBeInTheDocument();
    }
    const basic = screen.getByRole('region', { name: '基础信息' });
    expect(within(basic).getByText('https://agent.example.test')).toBeInTheDocument();
    expect(within(basic).getByText('生产')).toBeInTheDocument();
  });

  it('有算力卡时渲染卡表和合计，厂商显示「NVIDIA」', async () => {
    renderPage();
    const compute = await screen.findByRole('region', { name: '算力' });
    const rows = within(within(compute).getByRole('table')).getAllByRole('row');
    // 同一台服务器上两张一样的卡并成一行，数量 2；型号不再重复厂商名和显存
    expect(rows).toHaveLength(2);
    expect(within(rows[1]!).getByText('NVIDIA')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('A100')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('2')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('推理服务器')).toBeInTheDocument();
    expect(within(compute).getByText('共 2 张，显存 160 GB')).toBeInTheDocument();
    const env = screen.getByRole('region', { name: '环境' });
    expect(within(env).getByText('gpu-node-01')).toBeInTheDocument();
    expect(within(env).getByText('vLLM 0.6.3')).toBeInTheDocument();
  });

  it('没有服务器时环境里的服务器和算力块显示「—」', async () => {
    mocks.get.mockResolvedValue({
      ...profile,
      environment: { servers: [], software: [], components: [], frameworks: [] },
      compute: { accelerators: [], cardCount: 0, totalMemoryMB: null },
    });
    renderPage();
    const compute = await screen.findByRole('region', { name: '算力' });
    expect(within(compute).queryByRole('table')).not.toBeInTheDocument();
    expect(within(compute).getByText('—')).toBeInTheDocument();
    const env = screen.getByRole('region', { name: '环境' });
    expect(within(env).queryByRole('table')).not.toBeInTheDocument();
    expect(within(env).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('模型表含识别结论和最近评估', async () => {
    renderPage();
    const models = await screen.findByRole('region', { name: '模型' });
    expect(within(models).getByText('原始（官方指令版）')).toBeInTheDocument();
    expect(within(models).getByRole('link', { name: /82/ })).toHaveAttribute(
      'href',
      '/eval-tasks/task-1',
    );
  });

  it('风险小卡片点击跳检测结果页并带来源', async () => {
    renderPage();
    const risks = await screen.findByRole('region', { name: '风险' });
    await userEvent.click(within(risks).getByRole('link', { name: /^数据安全/ }));
    expect(screen.getByTestId('location')).toHaveTextContent(
      '/analysis/results?category=data&source=corpus&profile=p-1',
    );
  });

  it('主要风险表的来源记录链到记录', async () => {
    renderPage();
    const risks = await screen.findByRole('region', { name: '风险' });
    expect(within(risks).getByRole('link', { name: '客服模型评估' })).toHaveAttribute(
      'href',
      '/eval-tasks/task-1',
    );
  });

  it('处置建议按类别分组', async () => {
    renderPage();
    const box = await screen.findByRole('region', { name: '处置建议' });
    const groups = within(box).getAllByRole('group');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual([
      '数据安全',
      '内容安全',
      '应用与环境安全',
    ]);
    expect(within(groups[1]!).getByText('越狱与提示注入')).toBeInTheDocument();
    expect(within(groups[1]!).getByText('在网关拦截越狱模板')).toBeInTheDocument();
  });

  it('子树截断时提示只统计前 200 个', async () => {
    mocks.get.mockResolvedValue({ ...profile, truncated: true });
    renderPage();
    expect(await screen.findByText('关联资产过多，只统计前 200 个')).toBeInTheDocument();
  });

  it('风险块写明计数不全：语料命中过多、资产测绘次数过多', async () => {
    mocks.get.mockResolvedValue({
      ...profile,
      risks: {
        ...profile.risks,
        stats: { ...profile.risks.stats, truncatedCorpusScans: 2, discoveryRunsTruncated: true },
      },
    });
    renderPage();
    const risks = await screen.findByRole('region', { name: '风险' });
    expect(within(risks).getByText('2 次扫描命中过多，只计已保存的部分')).toBeInTheDocument();
    expect(within(risks).getByText('资产测绘超过 500 次，只计最近 500 次')).toBeInTheDocument();
  });

  it('最近评估没有分数时只显示时间，不出现「— 分」', async () => {
    mocks.get.mockResolvedValue({
      ...profile,
      models: [
        { ...profile.models[0]!, lastEval: { ...profile.models[0]!.lastEval!, score: null } },
      ],
    });
    renderPage();
    const models = await screen.findByRole('region', { name: '模型' });
    const link = within(models).getByRole('link');
    expect(link).toHaveAttribute('href', '/eval-tasks/task-1');
    expect(link.textContent).not.toContain('分');
  });

  it('处置动作为空时显示「—」', async () => {
    mocks.get.mockResolvedValue({
      ...profile,
      suggestions: [{ ...profile.suggestions[0]!, action: '' }],
    });
    renderPage();
    const box = await screen.findByRole('region', { name: '处置建议' });
    const item = within(box).getByText('越狱与提示注入').closest('li')!;
    expect(within(item).getByText('—')).toBeInTheDocument();
  });

  it('服务器表的系统、CPU、内存、GPU 取接口合好的值（探针优先、台账兜底）', async () => {
    renderPage();
    const env = await screen.findByRole('region', { name: '环境' });
    const table = within(env).getByRole('table', { name: '服务器' });
    expect(within(table).getByRole('columnheader', { name: 'GPU' })).toBeInTheDocument();
    const ledgerRow = within(table).getByText('应用服务器').closest('tr')!;
    expect(within(ledgerRow).getByText('CentOS 7.9')).toBeInTheDocument();
    expect(within(ledgerRow).getByText('Intel Xeon 8358')).toBeInTheDocument();
    expect(within(ledgerRow).getByText('256 GB')).toBeInTheDocument();
    const probeRow = within(table).getByText('推理服务器').closest('tr')!;
    expect(within(probeRow).getByText('NVIDIA A100 80GB × 2')).toBeInTheDocument();
    expect(within(probeRow).getByText('512 GB')).toBeInTheDocument();
  });

  it('模型的基座模型取接口合好的值，没有识别结论时也显示台账填的', async () => {
    renderPage();
    const models = await screen.findByRole('region', { name: '模型' });
    const row = within(models).getByText('向量模型').closest('tr')!;
    expect(within(row).getByText('BGE-M3（台账）')).toBeInTheDocument();
  });

  it('探针识别的框架和组件类型不重名；没有时整块不显示', async () => {
    renderPage();
    const env = await screen.findByRole('region', { name: '环境' });
    expect(within(env).getByRole('heading', { name: '服务器上的 AI 框架' })).toBeInTheDocument();
    expect(within(env).queryByRole('heading', { name: '训练推理框架' })).not.toBeInTheDocument();
    mocks.get.mockResolvedValue({
      ...profile,
      environment: { ...profile.environment, frameworks: [] },
    });
    renderPage();
    await screen.findAllByRole('region', { name: '环境' });
    expect(screen.getAllByRole('heading', { name: '服务器上的 AI 框架' })).toHaveLength(1);
  });

  it('算力表：同一台服务器上厂商、型号、显存、驱动相同的卡并一行带数量，其余分开', async () => {
    const cards = [
      card(0),
      card(1),
      card(2),
      { ...card(3), driverVersion: '535.00' },
      { ...card(0), serverName: '训练服务器' },
      {
        vendor: 'huawei',
        model: 'Ascend 910B',
        index: 1,
        source: 'npu-smi',
        serverName: '训练服务器',
      },
    ];
    mocks.get.mockResolvedValue({
      ...profile,
      compute: { accelerators: cards, cardCount: 6, totalMemoryMB: null },
    });
    renderPage();
    const compute = await screen.findByRole('region', { name: '算力' });
    const rows = within(within(compute).getByRole('table')).getAllByRole('row');
    expect(
      within(rows[0]!)
        .getAllByRole('columnheader')
        .map((c) => c.textContent),
    ).toEqual(['厂商', '型号', '显存', '驱动', '数量', '所在服务器']);
    expect(
      rows.slice(1).map((r) =>
        within(r)
          .getAllByRole('cell')
          .map((c) => c.textContent),
      ),
    ).toEqual([
      ['NVIDIA', 'A100', '80 GB', '550.54', '3', '推理服务器'],
      ['NVIDIA', 'A100', '80 GB', '535.00', '1', '推理服务器'],
      ['NVIDIA', 'A100', '80 GB', '550.54', '1', '训练服务器'],
      ['华为昇腾', 'Ascend 910B', '—', '—', '1', '训练服务器'],
    ]);
    expect(within(compute).getByText('共 6 张')).toBeInTheDocument();
  });

  it('型号只去掉开头的厂商名和末尾的显存，显存没单列时保留', () => {
    expect(acceleratorModel({ vendor: 'nvidia', model: 'NVIDIA A100 80GB', memoryMB: 81920 })).toBe(
      'A100',
    );
    expect(
      acceleratorModel({ vendor: 'nvidia', model: 'Tesla V100-SXM2-32GB', memoryMB: 32768 }),
    ).toBe('Tesla V100-SXM2');
    expect(acceleratorModel({ vendor: 'nvidia', model: 'NVIDIA A100 80GB' })).toBe('A100 80GB');
    expect(
      acceleratorModel({ vendor: 'nvidia', model: 'NVIDIA H100 80GB HBM3', memoryMB: 81920 }),
    ).toBe('H100 80GB HBM3');
    expect(acceleratorModel({ vendor: 'nvidia', model: 'NVIDIA', memoryMB: 81920 })).toBe('NVIDIA');
  });
});
