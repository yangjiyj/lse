import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LedgerAssetModal } from './LedgerAssetModal';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  endpointOptions: vi.fn(),
  targetOptions: vi.fn(),
  tree: vi.fn(),
}));

vi.mock('@/lib/ledger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ledger')>()),
  ledgerApi: {
    create: mocks.create,
    update: mocks.update,
    endpointOptions: mocks.endpointOptions,
    targetOptions: mocks.targetOptions,
  },
}));
vi.mock('@/lib/organizations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/organizations')>()),
  organizationApi: { tree: mocks.tree },
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

function renderModal(onSaved = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <LedgerAssetModal onClose={vi.fn()} onSaved={onSaved} />
    </QueryClientProvider>,
  );
  return onSaved;
}

describe('LedgerAssetModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tree.mockResolvedValue({
      items: [{ id: 'o-1', name: '总部', parentId: null, sort: 0, memberCount: 0, children: [] }],
    });
    mocks.endpointOptions.mockResolvedValue({
      items: [{ id: 'ep-1', hostname: 'gpu-node-01' }],
      total: 1,
      page: 1,
      pageSize: 100,
    });
    mocks.targetOptions.mockResolvedValue({
      items: [
        { id: 't-agent', name: '客服智能体', model: 'x', targetType: 'AGENT' },
        { id: 't-model', name: '通义千问', model: 'qwen', targetType: 'MODEL' },
      ],
      total: 2,
      page: 1,
      pageSize: 100,
    });
    mocks.create.mockImplementation(async (body) => ({ id: 'new', ...body }));
  });

  it('选「服务器」时出现 IP、操作系统、用途字段和关联终端', async () => {
    renderModal();
    expect(screen.getByLabelText('访问地址')).toBeInTheDocument();
    expect(screen.queryByLabelText('IP')).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText(/类型/), 'server');
    expect(screen.getByLabelText('IP')).toBeInTheDocument();
    expect(screen.getByLabelText('操作系统')).toBeInTheDocument();
    expect(screen.getByLabelText('用途')).toBeInTheDocument();
    expect(screen.queryByLabelText('访问地址')).not.toBeInTheDocument();
    expect(await screen.findByRole('option', { name: 'gpu-node-01' })).toBeInTheDocument();
    expect(screen.queryByLabelText('关联评估对象')).not.toBeInTheDocument();
  });

  it('关联终端按关键字查后端，选中后保留', async () => {
    renderModal();
    await userEvent.selectOptions(screen.getByLabelText(/类型/), 'server');
    await screen.findByRole('option', { name: 'gpu-node-01' });
    mocks.endpointOptions.mockResolvedValueOnce({
      items: [{ id: 'ep-9', hostname: 'gpu-node-99' }],
      total: 1,
      page: 1,
      pageSize: 50,
    });
    await userEvent.type(screen.getByLabelText('搜索终端'), 'node-99');
    await waitFor(() => expect(mocks.endpointOptions).toHaveBeenLastCalledWith('node-99'));
    await userEvent.selectOptions(
      screen.getByLabelText('关联终端'),
      await screen.findByRole('option', { name: 'gpu-node-99' }),
    );
    await userEvent.clear(screen.getByLabelText('搜索终端'));
    await waitFor(() => expect(mocks.endpointOptions).toHaveBeenLastCalledWith(''));
    expect(screen.getByLabelText('关联终端')).toHaveValue('ep-9');
    expect(screen.getByRole('option', { name: 'gpu-node-99' })).toBeInTheDocument();
  });

  it('应用平台的评估对象只列智能体、平台应用类', async () => {
    renderModal();
    expect(await screen.findByRole('option', { name: '客服智能体' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '通义千问' })).not.toBeInTheDocument();
  });

  it('提交的 attrs 只含所选类型的键，空值不提交', async () => {
    const onSaved = renderModal();
    await userEvent.type(screen.getByLabelText('访问地址'), 'https://app.example.com');
    await userEvent.selectOptions(screen.getByLabelText(/类型/), 'server');
    await userEvent.type(screen.getByLabelText(/名称/), '推理服务器');
    await userEvent.type(screen.getByLabelText('IP'), '10.0.0.8');
    await userEvent.type(screen.getByLabelText('内存（GB）'), '256');
    await userEvent.selectOptions(screen.getByLabelText('用途'), 'inference');
    await userEvent.type(screen.getByLabelText('标签'), '核心，GPU');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    const body = mocks.create.mock.calls[0]![0];
    expect(body.type).toBe('server');
    expect(body.name).toBe('推理服务器');
    expect(body.attrs).toEqual({ ip: '10.0.0.8', memoryGB: 256, purpose: 'inference' });
    expect(body.tags).toEqual(['核心', 'GPU']);
    expect(body.modelTargetId).toBeNull();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});
