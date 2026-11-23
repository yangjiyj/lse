import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import type { DictTypeDetail, DictTypeView } from '@/lib/dictionaries';
import { DictionariesPage } from './DictionariesPage';

const mocks = vi.hoisted(() => ({
  listTypes: vi.fn(),
  getType: vi.fn(),
  createType: vi.fn(),
  updateType: vi.fn(),
  deleteType: vi.fn(),
  createItem: vi.fn(),
  updateItem: vi.fn(),
  deleteItem: vi.fn(),
  reorder: vi.fn(),
  perms: new Set<string>(['system_setting:read', 'system_setting:update']),
}));

vi.mock('@/lib/dictionaries', () => ({
  dictionaryApi: {
    listTypes: mocks.listTypes,
    getType: mocks.getType,
    createType: mocks.createType,
    updateType: mocks.updateType,
    deleteType: mocks.deleteType,
    createItem: mocks.createItem,
    updateItem: mocks.updateItem,
    deleteItem: mocks.deleteItem,
    reorder: mocks.reorder,
  },
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: (code: string) => mocks.perms.has(code) }),
}));

const TS = '2026-11-17T00:00:00.000Z';
const RISK: DictTypeView = {
  id: 't-risk',
  code: 'risk_level',
  name: '风险等级',
  description: null,
  builtin: true,
  itemCount: 3,
  createdAt: TS,
  updatedAt: TS,
};
const KIND: DictTypeView = {
  ...RISK,
  id: 't-kind',
  code: 'ticket_kind',
  name: '工单分类',
  builtin: false,
  itemCount: 0,
};

function item(id: string, value: string, label: string, sort: number, enabled = true) {
  return { id, typeId: 't-risk', value, label, sort, enabled, createdAt: TS, updatedAt: TS };
}

const RISK_DETAIL: DictTypeDetail = {
  ...RISK,
  items: [
    item('i1', 'HIGH', '高风险', 1),
    item('i2', 'MEDIUM', '中风险', 2),
    item('i3', 'LOW', '低风险', 3),
  ],
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <DictionariesPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('DictionariesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.perms = new Set(['system_setting:read', 'system_setting:update']);
    mocks.listTypes.mockResolvedValue({ items: [RISK, KIND] });
    mocks.getType.mockImplementation(async (code: string) =>
      code === 'risk_level' ? RISK_DETAIL : { ...KIND, items: [] },
    );
    mocks.createItem.mockResolvedValue(item('i4', 'CRITICAL', '严重', 4));
    mocks.updateItem.mockResolvedValue(item('i1', 'HIGH', '高风险', 1, false));
    mocks.reorder.mockResolvedValue({ items: [] });
    mocks.createType.mockResolvedValue({ ...KIND, id: 't-new', code: 'source', name: '来源' });
  });

  it('左边列出类型，右边显示选中类型的全部条目；内置类型没有删除', async () => {
    renderPage();
    const types = await screen.findByRole('navigation', { name: '字典类型' });
    expect(within(types).getByRole('button', { name: /风险等级/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(within(types).getByRole('button', { name: /工单分类/ })).toBeInTheDocument();
    expect(await screen.findByRole('cell', { name: '高风险' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'HIGH' })).toBeInTheDocument();
    expect(mocks.getType).toHaveBeenCalledWith('risk_level');
    expect(screen.queryByRole('button', { name: '删除类型' })).not.toBeInTheDocument();

    await userEvent.click(within(types).getByRole('button', { name: /工单分类/ }));
    await waitFor(() => expect(mocks.getType).toHaveBeenCalledWith('ticket_kind'));
    expect(await screen.findByRole('button', { name: '删除类型' })).toBeInTheDocument();
  });

  it('新增条目；内置类型没有新增入口', async () => {
    renderPage();
    const types = await screen.findByRole('navigation', { name: '字典类型' });
    await screen.findByRole('cell', { name: '高风险' });
    expect(screen.queryByRole('button', { name: '新增条目' })).not.toBeInTheDocument();

    await userEvent.click(within(types).getByRole('button', { name: /工单分类/ }));
    await userEvent.click(await screen.findByRole('button', { name: '新增条目' }));
    const dialog = await screen.findByRole('dialog', { name: '新增条目' });
    await userEvent.type(within(dialog).getByLabelText(/值/), 'bug');
    await userEvent.type(within(dialog).getByLabelText(/名称/), '缺陷');
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(mocks.createItem).toHaveBeenCalledWith('ticket_kind', {
        value: 'bug',
        label: '缺陷',
      }),
    );
  });

  it('停用条目', async () => {
    renderPage();
    const row = (await screen.findByRole('cell', { name: '高风险' })).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: '停用' }));
    await waitFor(() =>
      expect(mocks.updateItem).toHaveBeenCalledWith('risk_level', 'i1', { enabled: false }),
    );
  });

  it('下移条目按新顺序提交', async () => {
    renderPage();
    const row = (await screen.findByRole('cell', { name: '高风险' })).closest('tr')!;
    expect(within(row).getByRole('button', { name: '上移' })).toBeDisabled();
    await userEvent.click(within(row).getByRole('button', { name: '下移' }));
    await waitFor(() =>
      expect(mocks.reorder).toHaveBeenCalledWith('risk_level', ['i2', 'i1', 'i3']),
    );
  });

  it('新建类型', async () => {
    renderPage();
    await screen.findByRole('navigation', { name: '字典类型' });
    await userEvent.click(screen.getByRole('button', { name: '新建类型' }));
    const dialog = await screen.findByRole('dialog', { name: '新建类型' });
    await userEvent.type(within(dialog).getByLabelText(/编码/), 'source');
    await userEvent.type(within(dialog).getByLabelText(/名称/), '来源');
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(mocks.createType).toHaveBeenCalledWith({
        code: 'source',
        name: '来源',
        description: null,
      }),
    );
  });

  it('内置类型的条目不能删除、不能改值，编辑只提交名称', async () => {
    renderPage();
    const row = (await screen.findByRole('cell', { name: '高风险' })).closest('tr')!;
    expect(within(row).queryByRole('button', { name: '删除' })).not.toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: '编辑' }));
    const dialog = await screen.findByRole('dialog', { name: '编辑条目' });
    expect(within(dialog).getByLabelText(/值/)).toBeDisabled();
    const label = within(dialog).getByLabelText(/名称/);
    await userEvent.clear(label);
    await userEvent.type(label, '高危');
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(mocks.updateItem).toHaveBeenCalledWith('risk_level', 'i1', { label: '高危' }),
    );
  });

  it('内置类型不能改名，只能改描述', async () => {
    mocks.updateType.mockResolvedValue({ ...RISK, description: '平台内置' });
    renderPage();
    await screen.findByRole('cell', { name: '高风险' });
    const typeEdit = screen
      .getAllByRole('button', { name: '编辑' })
      .find((button) => !button.closest('table'))!;
    await userEvent.click(typeEdit);
    const dialog = await screen.findByRole('dialog', { name: '编辑类型' });
    expect(within(dialog).getByLabelText(/名称/)).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/描述/), '平台内置');
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(mocks.updateType).toHaveBeenCalledWith('risk_level', { description: '平台内置' }),
    );
  });

  it('自定义类型的条目可以删除和改值', async () => {
    mocks.getType.mockImplementation(async (code: string) =>
      code === 'risk_level'
        ? RISK_DETAIL
        : { ...KIND, items: [{ ...item('k1', 'bug', '缺陷', 1), typeId: 't-kind' }] },
    );
    renderPage();
    const types = await screen.findByRole('navigation', { name: '字典类型' });
    await userEvent.click(within(types).getByRole('button', { name: /工单分类/ }));
    const row = (await screen.findByRole('cell', { name: '缺陷' })).closest('tr')!;
    expect(within(row).getByRole('button', { name: '删除' })).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: '编辑' }));
    const dialog = await screen.findByRole('dialog', { name: '编辑条目' });
    expect(within(dialog).getByLabelText(/值/)).toBeEnabled();
  });

  it('只有读权限时不显示任何编辑入口', async () => {
    mocks.perms = new Set(['system_setting:read']);
    renderPage();
    await screen.findByRole('cell', { name: '高风险' });
    expect(screen.queryByRole('button', { name: '新建类型' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '新增条目' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '停用' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下移' })).not.toBeInTheDocument();
  });
});
