import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import { BankCoveragePanel } from './BankCoveragePanel';
import { KeywordLibraryTab } from './KeywordLibraryTab';
import { KeywordListDrawer } from './KeywordListDrawer';

const mocks = vi.hoisted(() => ({
  keywordCoverage: vi.fn(),
  keywordImport: vi.fn(),
  keywordExport: vi.fn(),
  keywordList: vi.fn(),
  keywordSetStatus: vi.fn(),
  bankCoverage: vi.fn(),
  bankImport: vi.fn(),
  bankImportTemplate: vi.fn(),
  perms: new Set<string>(['question_set:create', 'question_set:update']),
  allTenants: false,
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    questionSets: {
      keywordCoverage: mocks.keywordCoverage,
      keywordImport: mocks.keywordImport,
      keywordExport: mocks.keywordExport,
      keywordList: mocks.keywordList,
      keywordSetStatus: mocks.keywordSetStatus,
      bankCoverage: mocks.bankCoverage,
      bankImport: mocks.bankImport,
      bankImportTemplate: mocks.bankImportTemplate,
    },
  },
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: (p: string) => mocks.perms.has(p) }),
}));
vi.mock('@/lib/tenant-view', () => ({
  useTenantView: () => ({ isAllTenants: mocks.allTenants }),
}));

const row = (key: string, label: string, count: number, min: number, importOnly = false) => ({
  key,
  label,
  count,
  min,
  gap: Math.max(0, min - count),
  ok: count >= min,
  importOnly,
});

function renderWith(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

const word = (
  id: string,
  term: string,
  reviewStatus: 'approved' | 'pending' | 'disabled' | 'rejected',
  over: Record<string, unknown> = {},
) => ({
  id,
  itemCode: 'A.1.d',
  itemName: '宣扬恐怖主义、极端主义',
  term,
  source: 'builtin:gbt45654',
  sourceLabel: '内置',
  reviewStatus,
  reviewStatusLabel: { approved: '在用', pending: '待确认', disabled: '停用', rejected: '已剔除' }[reviewStatus],
  statusChangedAt: null,
  statusChangedBy: null,
  editable: true,
  scope: '平台',
  createdAt: '2026-11-01T00:00:00.000Z',
  ...over,
});

const listOf = (items: ReturnType<typeof word>[], over: Record<string, unknown> = {}) => ({
  total: items.length,
  editableTotal: items.filter((i) => i.editable).length,
  page: 1,
  pageSize: 100,
  items,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.perms = new Set(['question_set:create', 'question_set:update']);
  mocks.allTenants = false;
});

describe('KeywordLibraryTab', () => {
  const coverage = {
    total: 330,
    totalMin: 10000,
    totalOk: false,
    rows: [
      row('A.1.a', 'A.1.a 煽动颠覆国家政权、推翻社会主义制度', 0, 200, true),
      row('A.1.d', 'A.1.d 宣扬恐怖主义、极端主义', 230, 200),
      row('A.2.a', 'A.2.a 民族歧视内容', 100, 100),
      row('A.3.a', 'A.3.a 侵犯他人知识产权', 0, 0),
    ],
    gaps: [row('A.1.a', 'A.1.a 煽动颠覆国家政权、推翻社会主义制度', 0, 200, true)],
    ok: false,
    pendingImportItems: ['A.1.a'],
    byStatus: { approved: 330, pending: 104, disabled: 315, rejected: 7 },
    byItemStatus: {
      'A.1.d': { approved: 230, pending: 104, disabled: 0 },
      'A.2.a': { approved: 100, pending: 0, disabled: 315 },
      'A.3.a': { approved: 0, pending: 0, disabled: 12 },
    },
  };

  it('小项表格只有「小项、在用、国标最少」三列；不够数的写「还差 N」，没有候选、停用、要求、达标这些说法', async () => {
    mocks.keywordCoverage.mockResolvedValue(coverage);
    renderWith(<KeywordLibraryTab />);
    expect(await screen.findByText(/以下小项的词数不够国标最少，需要导入/)).toBeInTheDocument();
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['小项', '在用', '国标最少']);
    const d = screen.getByRole('row', { name: /A\.1\.d/ });
    expect(within(d).getAllByRole('cell').map((c) => c.textContent)).toEqual(['A.1.d 宣扬恐怖主义、极端主义', '230', '200']);
    expect(within(screen.getByRole('row', { name: /A\.1\.a/ })).getAllByRole('cell').map((c) => c.textContent)).toEqual([
      'A.1.a 煽动颠覆国家政权、推翻社会主义制度',
      '0（还差 200）',
      '200',
    ]);
    expect(within(screen.getByRole('row', { name: /A\.3\.a/ })).getAllByRole('cell').map((c) => c.textContent)).toEqual([
      'A.3.a 侵犯他人知识产权',
      '0',
      '—',
    ]);
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/审校|政治类|不自行编写|候选|生效|达标/);
    expect(screen.queryByRole('button', { name: /审校通过|撤回/ })).toBeNull();
  });

  it('顶部写在用总数；有待确认的词时给「待确认 N 个」入口，点开只看待确认的', async () => {
    mocks.keywordCoverage.mockResolvedValue(coverage);
    mocks.keywordList.mockResolvedValue(listOf([word('w1', '候选词甲', 'pending', { source: 'auto:weekly', sourceLabel: '每周更新' })]));
    const user = userEvent.setup();
    renderWith(<KeywordLibraryTab />);
    await screen.findByText(/以下小项的词数不够国标最少/);
    expect(screen.getByText(/在用/, { selector: 'span' }).textContent).toMatch(/在用\s*330\s*个（国标要求不少于 10,000）/);
    await user.click(screen.getByRole('button', { name: '待确认 104 个' }));
    const drawer = await screen.findByRole('dialog', { name: '待确认的关键词' });
    await within(drawer).findByText('候选词甲');
    expect(mocks.keywordList).toHaveBeenLastCalledWith(expect.objectContaining({ reviewStatus: 'pending', itemCode: undefined }));
    expect(within(drawer).getByText('每周更新')).toBeInTheDocument();
  });

  it('没有待确认的词时不出现入口', async () => {
    mocks.keywordCoverage.mockResolvedValue({ ...coverage, byStatus: { approved: 330 } });
    renderWith(<KeywordLibraryTab />);
    await screen.findByText(/以下小项的词数不够国标最少/);
    expect(screen.queryByRole('button', { name: /^待确认/ })).toBeNull();
  });

  it('点小项打开抽屉：列出词、来源、最后修改人和时间，可搜索、按状态筛选', async () => {
    mocks.keywordCoverage.mockResolvedValue(coverage);
    mocks.keywordList.mockResolvedValue(
      listOf([
        word('w1', '恐怖词甲', 'approved'),
        word('w2', '恐怖词乙', 'disabled', { statusChangedBy: 'secadmin', statusChangedAt: '2026-11-22T06:30:00.000Z', source: 'import:csv', sourceLabel: '导入' }),
      ]),
    );
    const user = userEvent.setup();
    renderWith(<KeywordLibraryTab />);
    await user.click(await screen.findByRole('button', { name: 'A.1.d 宣扬恐怖主义、极端主义' }));
    const drawer = await screen.findByRole('dialog', { name: 'A.1.d 宣扬恐怖主义、极端主义' });
    await within(drawer).findByText('恐怖词甲');
    expect(mocks.keywordList).toHaveBeenLastCalledWith(expect.objectContaining({ itemCode: 'A.1.d', page: 1 }));
    const r2 = within(drawer).getByRole('row', { name: /恐怖词乙/ });
    expect(within(r2).getByText('导入')).toBeInTheDocument();
    expect(within(r2).getByText(/secadmin/)).toBeInTheDocument();
    expect(within(r2).getByText('停用')).toBeInTheDocument();
    expect(within(r2).getByRole('button', { name: '启用' })).toBeInTheDocument();
    expect(within(within(drawer).getByRole('row', { name: /恐怖词甲/ })).getByRole('button', { name: '停用' })).toBeInTheDocument();

    await user.selectOptions(within(drawer).getByRole('combobox', { name: '状态' }), 'disabled');
    await waitFor(() =>
      expect(mocks.keywordList).toHaveBeenLastCalledWith(expect.objectContaining({ itemCode: 'A.1.d', reviewStatus: 'disabled' })),
    );
    await user.type(within(drawer).getByRole('searchbox', { name: '搜索关键词' }), '乙');
    await waitFor(() =>
      expect(mocks.keywordList).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: '乙', reviewStatus: 'disabled' })),
    );
  });

  it('单个词：待确认的给「确认使用」，在用的给「停用」，直接改不弹框', async () => {
    mocks.keywordCoverage.mockResolvedValue(coverage);
    mocks.keywordList.mockResolvedValue(listOf([word('w1', '候选词甲', 'pending'), word('w2', '生效词乙', 'approved')]));
    mocks.keywordSetStatus.mockResolvedValue({ to: 'approved', itemCode: 'A.1.d', changed: 1 });
    const user = userEvent.setup();
    renderWith(<KeywordLibraryTab />);
    await user.click(await screen.findByRole('button', { name: 'A.1.d 宣扬恐怖主义、极端主义' }));
    const drawer = await screen.findByRole('dialog', { name: /A\.1\.d/ });
    const r1 = await within(drawer).findByRole('row', { name: /候选词甲/ });
    await user.click(within(r1).getByRole('button', { name: '确认使用' }));
    await waitFor(() => expect(mocks.keywordSetStatus).toHaveBeenCalledWith({ ids: ['w1'], to: 'approved' }));
    await user.click(within(within(drawer).getByRole('row', { name: /生效词乙/ })).getByRole('button', { name: '停用' }));
    await waitFor(() => expect(mocks.keywordSetStatus).toHaveBeenLastCalledWith({ ids: ['w2'], to: 'disabled' }));
  });

  it('勾选后批量停用要确认，写明后果；取消不改', async () => {
    mocks.keywordCoverage.mockResolvedValue(coverage);
    mocks.keywordList.mockResolvedValue(
      listOf([word('w1', '词一', 'approved'), word('w2', '词二', 'pending'), word('w3', '词三', 'disabled')]),
    );
    mocks.keywordSetStatus.mockResolvedValue({ to: 'disabled', itemCode: 'A.1.d', changed: 2 });
    const user = userEvent.setup();
    renderWith(<KeywordLibraryTab />);
    await user.click(await screen.findByRole('button', { name: 'A.1.d 宣扬恐怖主义、极端主义' }));
    const drawer = await screen.findByRole('dialog', { name: /A\.1\.d/ });
    await within(drawer).findByText('词一');
    await user.click(within(drawer).getByRole('checkbox', { name: '全选本页' }));
    const bar = within(drawer).getByRole('toolbar', { name: '批量操作' });
    expect(within(bar).getByText('已选 3 个')).toBeInTheDocument();

    await user.click(within(bar).getByRole('button', { name: '停用' }));
    let confirm = await screen.findByRole('dialog', { name: '停用关键词' });
    expect(within(confirm).getByText('这 2 个词将不再参与判定。')).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: '取消' }));
    expect(mocks.keywordSetStatus).not.toHaveBeenCalled();

    await user.click(within(bar).getByRole('button', { name: '停用' }));
    confirm = await screen.findByRole('dialog', { name: '停用关键词' });
    await user.click(within(confirm).getByRole('button', { name: '停用' }));
    await waitFor(() => expect(mocks.keywordSetStatus).toHaveBeenCalledWith({ ids: ['w1', 'w2'], to: 'disabled' }));
  });

  it('勾选后批量启用：这 N 个词将参与判定', async () => {
    mocks.keywordCoverage.mockResolvedValue(coverage);
    mocks.keywordList.mockResolvedValue(listOf([word('w1', '词一', 'approved'), word('w2', '词二', 'pending'), word('w3', '词三', 'disabled')]));
    mocks.keywordSetStatus.mockResolvedValue({ to: 'approved', itemCode: 'A.1.d', changed: 2 });
    const user = userEvent.setup();
    renderWith(<KeywordLibraryTab />);
    await user.click(await screen.findByRole('button', { name: 'A.1.d 宣扬恐怖主义、极端主义' }));
    const drawer = await screen.findByRole('dialog', { name: /A\.1\.d/ });
    await user.click(await within(drawer).findByRole('checkbox', { name: '选择 词二' }));
    await user.click(within(drawer).getByRole('checkbox', { name: '选择 词三' }));
    await user.click(within(within(drawer).getByRole('toolbar', { name: '批量操作' })).getByRole('button', { name: '启用' }));
    const confirm = await screen.findByRole('dialog', { name: '启用关键词' });
    expect(within(confirm).getByText('这 2 个词将参与判定。')).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: '启用' }));
    await waitFor(() => expect(mocks.keywordSetStatus).toHaveBeenCalledWith({ ids: ['w2', 'w3'], to: 'approved' }));
  });

  it('小项抽屉筛选候选时可「全部确认使用」，确认框写明数量，按小项 + 原状态提交', async () => {
    mocks.keywordCoverage.mockResolvedValue(coverage);
    mocks.keywordList.mockImplementation(async (q: { reviewStatus?: string }) =>
      q.reviewStatus === 'pending'
        ? listOf([word('w1', '候选词甲', 'pending')], { total: 104, editableTotal: 104 })
        : listOf([word('w0', '生效词', 'approved')]),
    );
    mocks.keywordSetStatus.mockResolvedValue({ to: 'approved', itemCode: 'A.1.d', changed: 104 });
    const user = userEvent.setup();
    renderWith(<KeywordLibraryTab />);
    await user.click(await screen.findByRole('button', { name: 'A.1.d 宣扬恐怖主义、极端主义' }));
    const drawer = await screen.findByRole('dialog', { name: /A\.1\.d/ });
    await within(drawer).findByText('生效词');
    expect(within(drawer).queryByRole('button', { name: /^全部/ })).toBeNull();
    await user.selectOptions(within(drawer).getByRole('combobox', { name: '状态' }), 'pending');
    await user.click(await within(drawer).findByRole('button', { name: '全部确认使用' }));
    const confirm = await screen.findByRole('dialog', { name: '确认使用' });
    expect(within(confirm).getByText('这 104 个词将参与判定。')).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: '确认使用' }));
    await waitFor(() =>
      expect(mocks.keywordSetStatus).toHaveBeenCalledWith({ itemCode: 'A.1.d', fromStatus: 'pending', to: 'approved' }),
    );
  });

  it('租户看平台词：没有勾选框和按钮', async () => {
    mocks.keywordCoverage.mockResolvedValue(coverage);
    mocks.keywordList.mockResolvedValue(
      listOf([
        word('w1', '平台词', 'approved', { editable: false }),
        word('w2', '本租户词', 'approved', { editable: true, scope: '本租户', source: 'import:txt', sourceLabel: '导入' }),
      ]),
    );
    const user = userEvent.setup();
    renderWith(<KeywordLibraryTab />);
    await user.click(await screen.findByRole('button', { name: 'A.1.d 宣扬恐怖主义、极端主义' }));
    const drawer = await screen.findByRole('dialog', { name: /A\.1\.d/ });
    const platform = await within(drawer).findByRole('row', { name: /平台词/ });
    expect(within(platform).queryByRole('checkbox')).toBeNull();
    expect(within(platform).queryByRole('button')).toBeNull();
    const own = within(drawer).getByRole('row', { name: /本租户词/ });
    expect(within(own).getByRole('checkbox')).toBeInTheDocument();
    expect(within(own).getByRole('button', { name: '停用' })).toBeInTheDocument();
  });

  it('没有更新权限时抽屉里没有勾选框和按钮', async () => {
    mocks.perms = new Set(['question_set:create']);
    mocks.keywordCoverage.mockResolvedValue(coverage);
    mocks.keywordList.mockResolvedValue(listOf([word('w1', '词一', 'approved')]));
    const user = userEvent.setup();
    renderWith(<KeywordLibraryTab />);
    await user.click(await screen.findByRole('button', { name: 'A.1.d 宣扬恐怖主义、极端主义' }));
    const drawer = await screen.findByRole('dialog', { name: /A\.1\.d/ });
    await within(drawer).findByText('词一');
    expect(within(drawer).queryByRole('checkbox')).toBeNull();
    expect(within(drawer).queryByRole('button', { name: /停用|启用|确认使用/ })).toBeNull();
  });

  it('选择文件和小项后导入，并带上文件内容', async () => {
    mocks.keywordCoverage.mockResolvedValue(coverage);
    mocks.keywordImport.mockResolvedValue({ totalRows: 2, added: 2, duplicates: 0, failed: 0, issues: [], byItem: {} });
    const user = userEvent.setup();
    const { container } = renderWith(<KeywordLibraryTab />);
    await screen.findByText(/以下小项的词数不够国标最少/);
    await user.selectOptions(screen.getByRole('combobox'), 'A.1.a');
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(['词一\n词二\n'], 'k.txt', { type: 'text/plain' }));
    await user.click(screen.getByRole('button', { name: '导入' }));
    await waitFor(() => expect(mocks.keywordImport).toHaveBeenCalled());
    expect(mocks.keywordImport.mock.calls[0]![0]).toMatchObject({
      format: 'txt',
      filename: 'k.txt',
      itemCode: 'A.1.a',
      content: '词一\n词二\n',
    });
  });

  it('没有创建权限时不显示导入入口', async () => {
    mocks.perms = new Set();
    mocks.keywordCoverage.mockResolvedValue(coverage);
    renderWith(<KeywordLibraryTab />);
    await screen.findByText(/以下小项的词数不够国标最少/);
    expect(screen.queryByRole('button', { name: '导入' })).toBeNull();
  });

  it('导入结果写明跳过了几行停用的词', async () => {
    mocks.keywordCoverage.mockResolvedValue(coverage);
    mocks.keywordImport.mockResolvedValue({
      totalRows: 5,
      added: 3,
      duplicates: 0,
      failed: 0,
      issues: [],
      byItem: {},
      skippedInactive: 2,
    });
    const user = userEvent.setup();
    const { container } = renderWith(<KeywordLibraryTab />);
    await screen.findByText(/以下小项的词数不够国标最少/);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(['itemCode,term,reviewStatus\n'], 'k.csv', { type: 'text/csv' }));
    await user.click(screen.getByRole('button', { name: '导入' }));
    expect(await screen.findByText(/已导入 3 个，重复 0 个，跳过停用的 2 行/)).toBeInTheDocument();
  });

  it('「待确认 N 个」打开的抽屉跨小项：多一列「小项」，改筛选后标题跟着变', async () => {
    mocks.keywordCoverage.mockResolvedValue(coverage);
    mocks.keywordList.mockResolvedValue(
      listOf([
        word('w1', '候选词甲', 'pending'),
        word('w2', '候选词乙', 'pending', { itemCode: 'A.2.a', itemName: '民族歧视内容' }),
      ]),
    );
    const user = userEvent.setup();
    renderWith(<KeywordLibraryTab />);
    await user.click(await screen.findByRole('button', { name: '待确认 104 个' }));
    let drawer = await screen.findByRole('dialog', { name: '待确认的关键词' });
    await within(drawer).findByText('候选词甲');
    expect(within(drawer).getAllByRole('columnheader').map((h) => h.textContent)).toContain('小项');
    expect(within(within(drawer).getByRole('row', { name: /候选词乙/ })).getByText('A.2.a')).toBeInTheDocument();
    await user.selectOptions(within(drawer).getByRole('combobox', { name: '状态' }), 'disabled');
    drawer = await screen.findByRole('dialog', { name: '停用的关键词' });
    await user.selectOptions(within(drawer).getByRole('combobox', { name: '状态' }), '');
    expect(await screen.findByRole('dialog', { name: '全部关键词' })).toBeInTheDocument();
  });

  it('小项抽屉不显示「小项」列', async () => {
    mocks.keywordCoverage.mockResolvedValue(coverage);
    mocks.keywordList.mockResolvedValue(listOf([word('w1', '恐怖词甲', 'approved')]));
    const user = userEvent.setup();
    renderWith(<KeywordLibraryTab />);
    await user.click(await screen.findByRole('button', { name: 'A.1.d 宣扬恐怖主义、极端主义' }));
    const drawer = await screen.findByRole('dialog', { name: /A\.1\.d/ });
    await within(drawer).findByText('恐怖词甲');
    expect(within(drawer).getAllByRole('columnheader').map((h) => h.textContent)).not.toContain('小项');
  });

  it('改动的是平台词表时，确认框写明影响所有租户', async () => {
    mocks.keywordCoverage.mockResolvedValue(coverage);
    mocks.keywordList.mockResolvedValue(
      listOf([word('w1', '词一', 'approved'), word('w2', '词二', 'disabled')], { writesPlatform: true }),
    );
    const user = userEvent.setup();
    renderWith(<KeywordLibraryTab />);
    await user.click(await screen.findByRole('button', { name: 'A.1.d 宣扬恐怖主义、极端主义' }));
    const drawer = await screen.findByRole('dialog', { name: /A\.1\.d/ });
    await user.click(await within(drawer).findByRole('checkbox', { name: '全选本页' }));
    const bar = within(drawer).getByRole('toolbar', { name: '批量操作' });
    await user.click(within(bar).getByRole('button', { name: '停用' }));
    const off = await screen.findByRole('dialog', { name: '停用关键词' });
    expect(within(off).getByText('这 1 个词将不再参与所有租户的判定。')).toBeInTheDocument();
    await user.click(within(off).getByRole('button', { name: '取消' }));
    await user.click(within(bar).getByRole('button', { name: '启用' }));
    const on = await screen.findByRole('dialog', { name: '启用关键词' });
    expect(within(on).getByText('这 1 个词将参与所有租户的判定。')).toBeInTheDocument();
  });

  it('全部租户视角：抽屉里没有勾选框和按钮', async () => {
    mocks.allTenants = true;
    mocks.keywordCoverage.mockResolvedValue(coverage);
    mocks.keywordList.mockResolvedValue(listOf([word('w1', '词一', 'approved')]));
    const user = userEvent.setup();
    renderWith(<KeywordLibraryTab />);
    await user.click(await screen.findByRole('button', { name: 'A.1.d 宣扬恐怖主义、极端主义' }));
    const drawer = await screen.findByRole('dialog', { name: /A\.1\.d/ });
    await within(drawer).findByText('词一');
    expect(within(drawer).queryByRole('checkbox')).toBeNull();
    expect(within(drawer).queryByRole('button', { name: /停用|启用|确认使用/ })).toBeNull();
  });

  it('没有修改人时「最后修改」只写时间', async () => {
    mocks.keywordCoverage.mockResolvedValue(coverage);
    mocks.keywordList.mockResolvedValue(
      listOf([
        word('w1', '平台改过', 'disabled', { editable: false, statusChangedAt: '2026-11-22T06:30:00.000Z', statusChangedBy: null }),
      ]),
    );
    const user = userEvent.setup();
    renderWith(<KeywordLibraryTab />);
    await user.click(await screen.findByRole('button', { name: 'A.1.d 宣扬恐怖主义、极端主义' }));
    const drawer = await screen.findByRole('dialog', { name: /A\.1\.d/ });
    const r = await within(drawer).findByRole('row', { name: /平台改过/ });
    const cells = within(r).getAllByRole('cell').map((c) => c.textContent ?? '');
    expect(cells.some((t) => /2026/.test(t))).toBe(true);
  });
});

describe('KeywordListDrawer 分页', () => {
  it('最后一页的词全部改掉后回到前一页，不停在空页', async () => {
    const disabled = new Set<string>();
    const all = () =>
      Array.from({ length: 101 }, (_, i) => word(`w${i}`, `词${String(i).padStart(3, '0')}`, 'approved')).filter(
        (w) => !disabled.has(w.id),
      );
    mocks.keywordList.mockImplementation(async (q: { page: number; pageSize: number }) => {
      const list = all();
      return listOf(list.slice((q.page - 1) * q.pageSize, q.page * q.pageSize), { total: list.length, page: q.page });
    });
    mocks.keywordSetStatus.mockImplementation(async (b: { ids: string[] }) => {
      for (const id of b.ids) disabled.add(id);
      return { to: 'disabled', itemCode: 'A.1.d', changed: b.ids.length };
    });
    const user = userEvent.setup();
    renderWith(<KeywordListDrawer title="A.1.d" itemCode="A.1.d" initialStatus="approved" canEdit onClose={() => {}} />);
    await screen.findByText('词000');
    await user.click(screen.getByRole('button', { name: /下一页/ }));
    await screen.findByText('词100');
    await user.click(screen.getByRole('button', { name: '停用' }));
    expect(await screen.findByText('词000')).toBeInTheDocument();
    expect(screen.queryByText('没有关键词')).toBeNull();
  });
});

describe('BankCoveragePanel', () => {
  it('分题库列出覆盖与缺口，只靠导入的小项标出「需导入」；说明不再写平台不编题', async () => {
    mocks.bankCoverage.mockResolvedValue({
      banks: [
        {
          bank: 'generation',
          label: '生成内容测试题库',
          total: 2300,
          totalMin: 2000,
          totalOk: true,
          rows: [row('A.1.a', 'A.1.a 煽动颠覆国家政权、推翻社会主义制度', 0, 50, true), row('A.2.a', 'A.2.a 民族歧视内容', 90, 50)],
          gaps: [row('A.1.a', 'x', 0, 50, true)],
          ok: false,
          pendingImportItems: ['A.1.a'],
        },
        {
          bank: 'non_refusal',
          label: '非拒答测试题库',
          total: 700,
          totalMin: 500,
          totalOk: true,
          rows: [row('制度', '制度', 50, 20)],
          gaps: [],
          ok: true,
          pendingImportItems: [],
        },
      ],
    });
    renderWith(<BankCoveragePanel />);
    expect(await screen.findByRole('heading', { name: /生成内容测试题库/ })).toBeInTheDocument();
    expect(screen.getByText('未满足附录 B')).toBeInTheDocument();
    expect(screen.getByText('满足附录 B')).toBeInTheDocument();
    expect(screen.getByText('需导入')).toBeInTheDocument();
    expect(screen.getByText(/1 项未达标/)).toBeInTheDocument();
    expect(screen.getByText(/各项均已达标/)).toBeInTheDocument();
    expect(screen.getByText(/内置题库已覆盖附录 A 31 项/)).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/政治类|不自行编写/);
  });

  it('按 JSONL 文件导入并带上题库类别', async () => {
    mocks.bankCoverage.mockResolvedValue({ banks: [] });
    mocks.bankImport.mockResolvedValue({ totalRows: 1, imported: 1, duplicates: 0, failed: 0, issues: [], byBank: {} });
    const user = userEvent.setup();
    const { container } = renderWith(<BankCoveragePanel />);
    await screen.findByRole('button', { name: '导入' });
    await user.selectOptions(screen.getByRole('combobox'), 'refusal');
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(['{"itemCode":"A.2.e","content":"题"}\n'], 'q.jsonl'));
    await user.click(screen.getByRole('button', { name: '导入' }));
    await waitFor(() => expect(mocks.bankImport).toHaveBeenCalled());
    expect(mocks.bankImport.mock.calls[0]![0]).toMatchObject({ format: 'jsonl', filename: 'q.jsonl', bank: 'refusal' });
  });
});
