import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import type { LedgerAssetDetail } from '@/lib/ledger';
import { LedgerAssetDetailPage } from './LedgerAssetDetailPage';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  createRelation: vi.fn(),
  quickItems: vi.fn(),
  quickJob: vi.fn(),
  perms: new Set<string>(['ledger:read', 'ledger:manage']),
}));

vi.mock('@/lib/ledger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ledger')>()),
  ledgerApi: {
    get: mocks.get,
    list: mocks.list,
    createRelation: mocks.createRelation,
    quickItems: mocks.quickItems,
    quickJob: mocks.quickJob,
  },
}));
// 子任务参数表单换成桩：只回传当前参数和「参数齐全」。
vi.mock('@/pages/detect-tasks/JobItemEditor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/pages/detect-tasks/JobItemEditor')>()),
  JobItemEditor: ({ kind }: { kind: string }) => <div data-testid={`editor-${kind}`} />,
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: (code: string) => mocks.perms.has(code) }),
}));

const TS = '2026-11-22T08:00:00.000Z';
function asset(over: Partial<LedgerAssetDetail>): LedgerAssetDetail {
  return {
    id: 'a-1',
    tenantId: 't',
    type: 'platform',
    name: '智能客服',
    displayName: '智能客服',
    code: null,
    description: '',
    ownerName: null,
    ownerDepartment: null,
    organizationId: null,
    organizationPath: null,
    tags: [],
    attrs: {},
    fleetEndpointId: null,
    modelTargetId: null,
    endpoint: null,
    target: null,
    relationCount: 0,
    createdAt: TS,
    updatedAt: TS,
    outgoing: [],
    incoming: [],
    hardware: null,
    ...over,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/ledger/a-1']}>
          <Routes>
            <Route path="/ledger/:id" element={<LedgerAssetDetailPage />} />
            <Route path="/detect-tasks/jobs/:id" element={<p>组合任务详情</p>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const optionLabels = (select: HTMLElement) =>
  within(select)
    .getAllByRole('option')
    .map((o) => o.textContent);

describe('LedgerAssetDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.perms = new Set(['ledger:read', 'ledger:manage']);
    mocks.list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 200, counts: {} });
    mocks.createRelation.mockResolvedValue({ id: 'r-new' });
  });

  it('关系添加的类型下拉只列 LEDGER_RELATION_RULES 允许的目标类型', async () => {
    mocks.get.mockResolvedValue(
      asset({
        outgoing: [
          {
            id: 'r-1',
            kind: 'uses',
            asset: { id: 'm-1', type: 'model', name: '通义千问' },
            createdAt: TS,
          },
        ],
        relationCount: 1,
      }),
    );
    mocks.list.mockResolvedValue({
      items: [asset({ id: 'm-2', type: 'model', name: 'DeepSeek', displayName: 'DeepSeek' })],
      total: 1,
      page: 1,
      pageSize: 200,
      counts: {},
    });
    renderPage();
    expect(await screen.findByRole('link', { name: '通义千问' })).toHaveAttribute(
      'href',
      '/ledger/m-1',
    );
    const kind = screen.getByLabelText('关系');
    expect(optionLabels(kind)).toEqual(['使用', '部署于', '包含']);
    const toType = screen.getByLabelText('对象类型');
    expect(optionLabels(toType)).toEqual(['AI 模型', 'AI 组件', '通用软件']);
    await userEvent.selectOptions(kind, 'deployed_on');
    expect(optionLabels(screen.getByLabelText('对象类型'))).toEqual(['服务器']);
    await userEvent.selectOptions(kind, 'contains');
    expect(optionLabels(screen.getByLabelText('对象类型'))).toEqual(['应用平台']);

    await userEvent.selectOptions(kind, 'uses');
    await screen.findByRole('option', { name: 'DeepSeek' });
    // 候选资产按关键字查后端，不是一次拉全
    await userEvent.type(screen.getByLabelText('搜索资产'), 'Deep');
    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith({ type: 'model', q: 'Deep', pageSize: 50 }),
    );
    await userEvent.selectOptions(
      await screen.findByLabelText('对象'),
      await screen.findByRole('option', { name: 'DeepSeek' }),
    );
    await userEvent.click(screen.getByRole('button', { name: '添加' }));
    await waitFor(() =>
      expect(mocks.createRelation).toHaveBeenCalledWith({
        fromId: 'a-1',
        toId: 'm-2',
        kind: 'uses',
      }),
    );
    // 平台不显示硬件
    expect(screen.queryByRole('region', { name: '硬件' })).not.toBeInTheDocument();
  });

  it('服务器有硬件时渲染算力卡表格，没有时显示「—」', async () => {
    mocks.get.mockResolvedValue(
      asset({
        type: 'server',
        name: '推理服务器',
        displayName: '推理服务器',
        attrs: { ip: '10.0.0.8', purpose: 'inference' },
        hardware: {
          collectedAt: TS,
          os: 'linux',
          osVersion: 'Ubuntu 22.04',
          platform: 'ubuntu',
          platformVersion: '22.04',
          kernelVersion: '5.15',
          arch: 'amd64',
          cpuModel: 'Intel Xeon',
          cpuCores: 64,
          cpuCountLogical: 128,
          memoryTotalMB: 524288,
          disks: null,
          accelerators: [
            { vendor: 'nvidia', model: 'NVIDIA A800', memoryMB: 81920, source: 'nvidia-smi' },
          ],
          acceleratorErrors: null,
          aiComponents: null,
          aiComponentErrors: null,
        },
      }),
    );
    const view = renderPage();
    const table = await screen.findByRole('table', { name: '算力卡' });
    expect(within(table).getByText('NVIDIA A800')).toBeInTheDocument();
    expect(screen.getByText('推理')).toBeInTheDocument();
    view.unmount();

    mocks.get.mockResolvedValue(
      asset({ type: 'server', name: '无终端服务器', displayName: '无终端服务器' }),
    );
    renderPage();
    expect(await screen.findByTestId('accelerators')).toHaveTextContent('—');
    expect(screen.queryByRole('table', { name: '算力卡' })).not.toBeInTheDocument();
  });

  it('没有 ledger:manage 时不能添加关系、编辑、删除', async () => {
    mocks.perms = new Set(['ledger:read']);
    mocks.get.mockResolvedValue(asset({}));
    renderPage();
    await screen.findByRole('heading', { name: '智能客服' });
    expect(screen.queryByRole('button', { name: '添加' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除' })).not.toBeInTheDocument();
  });

  it('相关任务列出关联到资产的子任务；快速建任务提交的 items 只含勾选项', async () => {
    mocks.perms = new Set([
      'ledger:read',
      'detect_task:manage',
      'detect_task:read',
      'service_assurance:scan',
    ]);
    mocks.get.mockResolvedValue(
      asset({
        type: 'server',
        name: '推理服务器',
        displayName: '推理服务器',
        jobItems: [
          {
            id: 'ji-1',
            jobId: 'job-1',
            jobName: '推理服务器 · 2026-11-22',
            jobStatus: 'RUNNING',
            triggeredBy: 'quick',
            kind: 'fleet_posture',
            title: '终端配置体检 · 推理服务器',
            status: 'COMPLETED',
            recordKind: 'fleet_eval_job',
            recordId: 'task-1',
            href: '/eval-tasks/task-1',
            createdAt: TS,
          },
        ],
      }),
    );
    mocks.quickItems.mockResolvedValue({
      auto: [
        {
          jobKind: 'fleet_posture',
          entryKey: 'fleet-posture',
          category: 'app_env',
          title: '终端配置体检 · 推理服务器',
          params: { endpointId: 'ep-1' },
          ready: true,
          missing: [],
        },
        {
          jobKind: 'asset_discovery',
          entryKey: 'asset-discovery',
          category: 'app_env',
          title: 'AI 资产测绘 · 推理服务器',
          params: { targets: ['10.0.0.8'], ports: [80], confirm: true },
          ready: true,
          missing: [],
        },
      ],
      manual: [
        {
          entryKey: 'service-assurance',
          category: 'app_env',
          title: 'AI 服务安全核验 · 推理服务器',
          params: {},
          createPath: '/service-assurance',
        },
      ],
    });
    mocks.quickJob.mockResolvedValue({ id: 'job-9' });
    renderPage();
    const related = await screen.findByRole('table', { name: '相关任务' });
    expect(
      within(related).getByRole('link', { name: '终端配置体检 · 推理服务器' }),
    ).toHaveAttribute('href', '/eval-tasks/task-1');
    expect(within(related).getByRole('link', { name: '推理服务器 · 2026-11-22' })).toHaveAttribute(
      'href',
      '/detect-tasks/jobs/job-1',
    );
    // 没有 ledger:manage：不能编辑、删除，但能快速建任务
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '快速建任务' }));
    const dialog = await screen.findByRole('dialog', { name: '快速建任务' });
    expect(
      within(dialog).getByRole('link', { name: 'AI 服务安全核验 · 推理服务器' }),
    ).toHaveAttribute('href', '/service-assurance');
    const discovery = within(dialog).getByRole('checkbox', { name: 'AI 资产测绘 · 推理服务器' });
    expect(discovery).toBeChecked();
    await userEvent.click(discovery);
    expect(within(dialog).queryByTestId('editor-asset_discovery')).not.toBeInTheDocument();
    expect(within(dialog).getByTestId('editor-fleet_posture')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: '建任务' }));
    await waitFor(() =>
      expect(mocks.quickJob).toHaveBeenCalledWith('a-1', {
        items: [
          {
            jobKind: 'fleet_posture',
            title: '终端配置体检 · 推理服务器',
            params: { endpointId: 'ep-1' },
          },
        ],
        start: false,
      }),
    );
    expect(await screen.findByText('组合任务详情')).toBeInTheDocument();
  });

  it('没有 detect_task:read 时不显示相关任务；没有 detect_task:manage 时没有快速建任务', async () => {
    mocks.perms = new Set(['ledger:read']);
    mocks.get.mockResolvedValue(asset({}));
    renderPage();
    await screen.findByRole('heading', { name: '智能客服' });
    expect(screen.queryByRole('heading', { name: '相关任务' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '快速建任务' })).not.toBeInTheDocument();
  });

  it('快速建任务：没有发起权限的人工入口只显示名称，不给链接', async () => {
    mocks.perms = new Set(['ledger:read', 'detect_task:manage']);
    mocks.get.mockResolvedValue(asset({ type: 'software', name: '数据库', displayName: '数据库' }));
    mocks.quickItems.mockResolvedValue({
      auto: [],
      manual: [
        {
          entryKey: 'service-assurance',
          category: 'app_env',
          title: 'AI 服务安全核验 · 数据库',
          params: {},
          createPath: '/service-assurance',
        },
      ],
    });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: '快速建任务' }));
    const dialog = await screen.findByRole('dialog', { name: '快速建任务' });
    expect(await within(dialog).findByText('AI 服务安全核验 · 数据库')).toBeInTheDocument();
    expect(within(dialog).queryByRole('link')).toBeNull();
  });

  it('应用平台有「安全画像」入口，其他类型没有', async () => {
    mocks.get.mockResolvedValue(asset({}));
    const view = renderPage();
    expect(await screen.findByRole('link', { name: '安全画像' })).toHaveAttribute(
      'href',
      '/analysis/profiles/a-1',
    );
    view.unmount();
    mocks.get.mockResolvedValue(
      asset({ type: 'server', name: '推理服务器', displayName: '推理服务器' }),
    );
    renderPage();
    expect(await screen.findByRole('heading', { name: '推理服务器' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '安全画像' })).not.toBeInTheDocument();
  });

  it('标题用资产自己的名称，关联的评估对象在基本信息里显示；关系添加的搜索和选择在同一行', async () => {
    mocks.get.mockResolvedValue(
      asset({
        type: 'model',
        name: 'Qwen2.5-72B-Instruct',
        displayName: 'Qwen2.5-72B-Instruct',
        modelTargetId: 't-1',
        target: {
          id: 't-1',
          name: '客服大模型 Qwen2.5-72B',
          model: 'qwen2.5-72b',
          targetType: 'MODEL',
        },
      }),
    );
    renderPage();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Qwen2.5-72B-Instruct' }),
    ).toBeInTheDocument();
    const linked = screen.getByText('关联评估对象').closest('div')!;
    expect(within(linked).getByText('客服大模型 Qwen2.5-72B')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '关联对象' })).not.toBeInTheDocument();
    const search = screen.getByLabelText('搜索资产');
    expect(search.parentElement).toHaveClass('flex', 'items-center');
    expect(search.parentElement).toContainElement(screen.getByLabelText('对象'));
  });

  it('相关任务：没启动的子任务显示「未启动」，已建记录在排队的显示「排队中」', async () => {
    mocks.perms = new Set(['ledger:read', 'detect_task:read']);
    const base = {
      jobId: 'job-1',
      jobName: '上线前检测',
      jobStatus: 'PENDING',
      triggeredBy: 'scheme',
      kind: 'eval_task',
      createdAt: TS,
    };
    mocks.get.mockResolvedValue(
      asset({
        jobItems: [
          {
            ...base,
            id: 'ji-1',
            title: '内容安全评估 · 客服',
            status: 'PENDING',
            recordKind: null,
            recordId: null,
            href: null,
          },
          {
            ...base,
            id: 'ji-2',
            jobId: 'job-2',
            jobName: '每周例行',
            jobStatus: 'RUNNING',
            kind: 'model_scan',
            title: '模型文件扫描 · 客服',
            status: 'PENDING',
            recordKind: 'model_scan',
            recordId: 'm-1',
            href: '/model-scans/m-1',
          },
        ],
      }),
    );
    renderPage();
    const related = await screen.findByRole('table', { name: '相关任务' });
    const waiting = within(related).getByText('内容安全评估 · 客服').closest('tr')!;
    expect(within(waiting).getByText('未启动')).toBeInTheDocument();
    expect(within(waiting).queryByText('排队中')).toBeNull();
    const queued = within(related)
      .getByRole('link', { name: '模型文件扫描 · 客服' })
      .closest('tr')!;
    expect(within(queued).getByText('排队中')).toBeInTheDocument();
  });
});
