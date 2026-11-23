import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantItem, TenantTransferPlan } from '@/lib/api';
import { TenantTransferDialog } from './TenantTransferDialog';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  preflight: vi.fn(),
  transfer: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    tenants: {
      list: mocks.list,
      transferPreflight: mocks.preflight,
      transfer: mocks.transfer,
    },
  },
}));

function tenant(over: Partial<TenantItem> & { id: string; name: string }): TenantItem {
  return {
    description: null,
    isActive: true,
    isPlatform: false,
    createdAt: '2026-11-01T00:00:00.000Z',
    userCount: 1,
    targetCount: 0,
    endpointCount: 0,
    taskCount: 0,
    lastTaskAt: null,
    ...over,
  };
}

function plan(over: Partial<TenantTransferPlan> = {}): TenantTransferPlan {
  return {
    kind: 'model-target',
    kindLabel: '评估对象',
    sourceTenant: { id: 't-a', name: '默认租户' },
    targetTenant: { id: 't-b', name: '乙单位' },
    roots: [{ id: 'm1', name: '4o 生产环境', tenantId: 't-a' }],
    counts: {
      modelTarget: { label: '评估对象', count: 1 },
      evalTask: { label: '评估任务', count: 3 },
      evalResult: { label: '评估结果', count: 40 },
    },
    totalRows: 44,
    blockers: [],
    warnings: [{ code: 'INVISIBLE_AFTER', message: '转移后原租户的用户将不再看到这些资产' }],
    canTransfer: true,
    ...over,
  };
}

function renderDialog(onTransferred = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TenantTransferDialog
        open
        kind="model-target"
        ids={['m1']}
        onClose={() => undefined}
        onTransferred={onTransferred}
      />
    </QueryClientProvider>,
  );
  return onTransferred;
}

beforeEach(() => {
  mocks.list.mockResolvedValue({
    items: [
      tenant({ id: 't-a', name: '默认租户', isPlatform: true }),
      tenant({ id: 't-b', name: '乙单位' }),
    ],
  });
  mocks.preflight.mockReset();
  mocks.transfer.mockReset();
});

describe('资产归属转移对话框', () => {
  it('选目标租户后列出将转移的条数，并提示不可逆', async () => {
    mocks.preflight.mockResolvedValue(plan());
    renderDialog();

    await screen.findByRole('option', { name: /乙单位/ });
    await userEvent.selectOptions(screen.getByTestId('transfer-target'), 't-b');

    await waitFor(() => expect(mocks.preflight).toHaveBeenCalledWith({
      kind: 'model-target',
      ids: ['m1'],
      targetTenantId: 't-b',
    }));
    expect(await screen.findByText(/将转移 1 个评估对象，共 44 条记录/)).toBeInTheDocument();
    expect(screen.getByText('评估任务')).toBeInTheDocument();
    expect(screen.getByText('40')).toBeInTheDocument();
    expect(screen.getByText(/原租户的用户将不再看到/)).toBeInTheDocument();
  });

  it('有阻塞项时禁用确认，并逐条说明原因', async () => {
    mocks.preflight.mockResolvedValue(
      plan({
        canTransfer: false,
        blockers: [
          {
            code: 'FOREIGN_QUESTION_SET',
            message: '任务引用了本租户自建题集「内部红队 v2」',
          },
        ],
      }),
    );
    renderDialog();

    await screen.findByRole('option', { name: /乙单位/ });
    await userEvent.selectOptions(screen.getByTestId('transfer-target'), 't-b');

    expect(await screen.findByText(/内部红队 v2/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认转移' })).toBeDisabled();
  });

  it('确认后调用转移接口，并把结果交回调用方', async () => {
    mocks.preflight.mockResolvedValue(plan());
    mocks.transfer.mockResolvedValue({ plan: plan(), applied: { modelTarget: 1 }, totalRows: 44 });
    const onTransferred = renderDialog();

    await screen.findByRole('option', { name: /乙单位/ });
    await userEvent.selectOptions(screen.getByTestId('transfer-target'), 't-b');
    const confirm = await screen.findByRole('button', { name: '确认转移' });
    await waitFor(() => expect(confirm).toBeEnabled());
    await userEvent.click(confirm);

    await waitFor(() =>
      expect(mocks.transfer).toHaveBeenCalledWith({
        kind: 'model-target',
        ids: ['m1'],
        targetTenantId: 't-b',
      }),
    );
    await waitFor(() => expect(onTransferred).toHaveBeenCalled());
    expect(onTransferred.mock.calls[0]?.[0]).toContain('乙单位');
  });
});
