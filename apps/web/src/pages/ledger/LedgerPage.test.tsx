import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import type { LedgerAsset } from '@/lib/ledger';
import { LedgerPage } from './LedgerPage';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  importEndpoints: vi.fn(),
  importTargets: vi.fn(),
  tree: vi.fn(),
  perms: new Set<string>(['ledger:read', 'ledger:manage']),
}));

vi.mock('@/lib/ledger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ledger')>()),
  ledgerApi: {
    list: mocks.list,
    importEndpoints: mocks.importEndpoints,
    importTargets: mocks.importTargets,
  },
}));
vi.mock('@/lib/organizations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/organizations')>()),
  organizationApi: { tree: mocks.tree },
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: (code: string) => mocks.perms.has(code) }),
}));

const TS = '2026-11-22T08:00:00.000Z';
const SERVER: LedgerAsset = {
  id: 'a-1',
  tenantId: 't',
  type: 'server',
  name: '推理服务器别名',
  displayName: 'gpu-node-01',
  code: 'SRV-01',
  description: '',
  ownerName: '张三',
  ownerDepartment: '运维部',
  organizationId: null,
  organizationPath: null,
  tags: [],
  attrs: { ip: '10.0.0.8', os: 'Ubuntu 22.04', purpose: 'inference' },
  fleetEndpointId: 'ep-1',
  modelTargetId: null,
  endpoint: { id: 'ep-1', hostname: 'gpu-node-01', os: 'linux', lastSeenAt: TS, removed: false },
  target: null,
  relationCount: 2,
  createdAt: TS,
  updatedAt: TS,
};
const COUNTS = { platform: 1, server: 1, endpoint: 0, software: 0, model: 2, component: 0 };

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <LedgerPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('LedgerPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.perms = new Set(['ledger:read', 'ledger:manage']);
    mocks.list.mockResolvedValue({
      items: [SERVER],
      total: 1,
      page: 1,
      pageSize: 20,
      counts: COUNTS,
    });
    mocks.tree.mockResolvedValue({ items: [] });
    mocks.importEndpoints.mockResolvedValue({ created: 2, skipped: 0 });
  });

  it('左边类型带计数；切换类型时调接口带 type', async () => {
    renderPage();
    const link = await screen.findByRole('link', { name: '推理服务器别名' });
    expect(link).toHaveAttribute('href', '/ledger/a-1');
    // 名称一律用台账里的资产名称，过长截断时 title 给全名；关联终端的主机名不在列表里显示
    expect(link).toHaveAttribute('title', '推理服务器别名');
    expect(screen.queryByText('gpu-node-01')).not.toBeInTheDocument();
    expect(screen.getByTitle('张三 · 运维部')).toHaveTextContent('张三 · 运维部');
    expect(screen.getByText('10.0.0.8 · Ubuntu 22.04')).toBeInTheDocument();
    expect(mocks.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: undefined, page: 1 }),
    );
    const model = screen.getByRole('button', { name: /AI 模型/ });
    expect(model).toHaveTextContent('2');
    expect(screen.getByRole('button', { name: /全部/ })).toHaveTextContent('4');

    await userEvent.click(screen.getByRole('button', { name: /服务器/ }));
    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'server' })),
    );
    expect(screen.getByRole('button', { name: /服务器/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('有 ledger:manage 时能新建、导入；导入前要确认，取消就不调接口', async () => {
    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    renderPage();
    await screen.findByRole('link', { name: '推理服务器别名' });
    expect(screen.getByRole('button', { name: '新建资产' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导入评估对象' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '导入终端' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(mocks.importEndpoints).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '导入终端' }));
    await waitFor(() => expect(mocks.importEndpoints).toHaveBeenCalledTimes(1));
    confirm.mockRestore();
  });

  it('搜索框输入停下后才按关键字查', async () => {
    renderPage();
    await screen.findByRole('link', { name: '推理服务器别名' });
    const calls = mocks.list.mock.calls.length;
    await userEvent.type(screen.getByLabelText('搜索资产'), '10.0');
    // 敲字过程中不按每个字发请求
    expect(mocks.list.mock.calls.length).toBe(calls);
    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({ q: '10.0' })),
    );
    expect(mocks.list.mock.calls.filter((c) => c[0].q).map((c) => c[0].q)).toEqual(['10.0']);
  });

  it('没有 ledger:manage 时没有新建、导入按钮', async () => {
    mocks.perms = new Set(['ledger:read']);
    renderPage();
    await screen.findByRole('link', { name: '推理服务器别名' });
    expect(screen.queryByRole('button', { name: '新建资产' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '导入终端' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '导入评估对象' })).not.toBeInTheDocument();
  });

  it('当前页都没填组织时不显示组织列，有一行填了就显示', async () => {
    renderPage();
    const table = await screen.findByRole('table', { name: '资产' });
    expect(within(table).queryByRole('columnheader', { name: '组织' })).not.toBeInTheDocument();
    cleanup();
    mocks.list.mockResolvedValue({
      items: [SERVER, { ...SERVER, id: 'a-2', name: '另一台', organizationPath: '总部 / 运维部' }],
      total: 2,
      page: 1,
      pageSize: 20,
      counts: COUNTS,
    });
    renderPage();
    const again = await screen.findByRole('table', { name: '资产' });
    expect(within(again).getByRole('columnheader', { name: '组织' })).toBeInTheDocument();
    expect(within(again).getByTitle('总部 / 运维部')).toBeInTheDocument();
  });
});
