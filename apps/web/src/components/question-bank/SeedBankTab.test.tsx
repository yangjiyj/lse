import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SeedBankCard } from './SeedBankCard';
import { SeedBankTab } from './SeedBankTab';
import { RunRecordsTab } from './RunRecordsTab';

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('@/lib/api', () => ({
  api: {
    questionSets: { list: mocks.list, builtinStats: vi.fn().mockResolvedValue({ categories: [] }) },
  },
}));
vi.mock('./BuiltinBankPanel', () => ({ BuiltinBankPanel: () => <div>分类树面板</div> }));

const base = {
  id: 's1',
  name: 'Safety-Prompts 安全题库',
  description: null,
  type: 'GENERAL',
  tags: [],
  source: 'builtin:dataset:safety-prompts',
  isBuiltin: true,
  kind: 'seed' as const,
  questionCount: 99798,
  importCount: 0,
  taskLinkCount: 0,
  riskCoverage: ['内容安全'],
  createdBy: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe('SeedBankCard', () => {
  it('展示来源许可、题数、用途，大库给出抽样提示，并渲染 actions 插槽', () => {
    render(<SeedBankCard set={base} actions={<button>变异扩展</button>} />);
    expect(screen.getByText(/Apache-2\.0/)).toBeTruthy();
    expect(screen.getByText('99,798')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toContain('抽样题数');
    expect(screen.getByRole('button', { name: '变异扩展' })).toBeTruthy();
  });
  it('小库不显示大规模提示', () => {
    render(<SeedBankCard set={{ ...base, questionCount: 30 }} />);
    expect(screen.queryByRole('note')).toBeNull();
  });
});

describe('SeedBankTab', () => {
  it('按 kind=seed 取数，并可切换到附录 A 分类树', async () => {
    mocks.list.mockResolvedValue({ items: [base], total: 1 });
    render(
      <QueryClientProvider client={qc()}>
        <SeedBankTab renderActions={() => <button>变异扩展</button>} />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId('seed-bank-card')).toBeTruthy();
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ kind: 'seed' }));
    expect(screen.getByRole('button', { name: '变异扩展' })).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'GB/T 45654-2025 附录 A' }));
    expect(screen.getByText('分类树面板')).toBeTruthy();
  });
});

describe('SeedBankTab 按用途分组', () => {
  const mk = (
    id: string,
    name: string,
    source: string,
    questionCount: number,
    activeQuestionCount = questionCount,
  ) => ({
    ...base,
    id,
    name,
    source,
    questionCount,
    activeQuestionCount,
    riskCoverage: [],
  });
  const renderTab = () =>
    render(
      <QueryClientProvider client={qc()}>
        <SeedBankTab />
      </QueryClientProvider>,
    );

  it('分成国标合规检测题库、对抗演练种子、可选题源三组，认不出的来源归可选题源', async () => {
    mocks.list.mockResolvedValue({
      items: [
        mk('a', 'Safety-Prompts', 'builtin:dataset:safety-prompts', 99798),
        mk('b', '红队深度包', 'builtin:red-team:deep', 144),
        mk('c', '国标非拒答题库', 'builtin:gbt45654:non-refusal', 858, 707),
        mk('d', '国标生成内容题库', 'builtin:gbt45654:generation', 3312, 2703),
        mk('e', 'TC260 摸底题', 'builtin:compliance:tc260', 186),
        mk('f', '国标应拒答题库', 'builtin:gbt45654:refusal', 906, 739),
        mk('g', '红队冒烟包', 'builtin:red-team', 12),
        mk('h', 'MCP 攻击样本', 'builtin:mcp:attacks', 18),
        mk('i', '基准样例', 'benchmark:lse-safety-mini', 30),
        mk('j', '来历不明', 'something:else', 5),
      ],
      total: 10,
    });
    renderTab();
    await screen.findAllByTestId('seed-bank-card');
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      '国标合规检测题库',
      '对抗演练种子',
      '可选题源',
    ]);
    const names = (title: string) =>
      within(screen.getByRole('region', { name: title }))
        .getAllByTestId('seed-bank-card')
        .map((c) => c.getAttribute('aria-label'));
    expect(names('国标合规检测题库')).toEqual([
      '种子库 国标生成内容题库',
      '种子库 国标应拒答题库',
      '种子库 国标非拒答题库',
    ]);
    expect(names('对抗演练种子')).toEqual(['种子库 红队深度包', '种子库 红队冒烟包']);
    expect(names('可选题源')).toEqual([
      '种子库 Safety-Prompts',
      '种子库 TC260 摸底题',
      '种子库 MCP 攻击样本',
      '种子库 基准样例',
      '种子库 来历不明',
    ]);
  });

  it('国标库显示「在用题数 / 要求 N」，用的是在用题数；不足时标红', async () => {
    mocks.list.mockResolvedValue({
      items: [
        mk('d', '国标生成内容题库', 'builtin:gbt45654:generation', 3312, 1999),
        mk('f', '国标应拒答题库', 'builtin:gbt45654:refusal', 906, 739),
        mk('a', 'Safety-Prompts', 'builtin:dataset:safety-prompts', 99798),
      ],
      total: 3,
    });
    renderTab();
    const gen = await screen.findByRole('article', { name: '种子库 国标生成内容题库' });
    expect(within(gen).getByText('1,999')).toBeTruthy();
    expect(within(gen).queryByText('3,312')).toBeNull();
    expect(within(gen).getByText('在用 / 要求 2,000')).toBeTruthy();
    expect(within(gen).getByText('1,999').className).toMatch(/text-severity-critical/);
    const ref = screen.getByRole('article', { name: '种子库 国标应拒答题库' });
    expect(within(ref).getByText('739')).toBeTruthy();
    expect(within(ref).getByText('在用 / 要求 500')).toBeTruthy();
    expect(within(ref).getByText('739').className).not.toMatch(/text-severity-critical/);
    // 其他题源仍按原样显示「题」
    const sp = screen.getByRole('article', { name: '种子库 Safety-Prompts' });
    expect(within(sp).getByText('99,798')).toBeTruthy();
    expect(within(sp).getByText('题')).toBeTruthy();
  });

  it('国标组宽屏三列一行，卡片标题用短名不折行；其他组仍两列', async () => {
    mocks.list.mockResolvedValue({
      items: [
        mk(
          'd',
          '内置国标题库 · 生成内容测试题库（GB/T 45654-2025 附录 B）',
          'builtin:gbt45654:generation',
          3312,
          2703,
        ),
        mk(
          'f',
          '内置国标题库 · 应拒答测试题库（GB/T 45654-2025 附录 B）',
          'builtin:gbt45654:refusal',
          906,
          739,
        ),
        mk(
          'c',
          '内置国标题库 · 非拒答测试题库（GB/T 45654-2025 附录 B）',
          'builtin:gbt45654:non-refusal',
          858,
          707,
        ),
        mk('b', '红队深度包', 'builtin:red-team:deep', 144),
      ],
      total: 4,
    });
    renderTab();
    await screen.findAllByTestId('seed-bank-card');
    const gbt = screen.getByRole('region', { name: '国标合规检测题库' });
    const grid = within(gbt).getAllByTestId('seed-bank-card')[0]!.parentElement!;
    expect(grid.className).toMatch(/xl:grid-cols-3/);
    expect(
      within(gbt)
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(['生成内容测试题库内置', '应拒答测试题库内置', '非拒答测试题库内置']);
    const red = screen.getByRole('region', { name: '对抗演练种子' });
    expect(within(red).getAllByTestId('seed-bank-card')[0]!.parentElement!.className).not.toMatch(
      /xl:grid-cols-3/,
    );
    expect(within(red).getByRole('heading', { level: 3 }).textContent).toContain('红队深度包');
  });

  it('某组没有题源时不显示该组标题', async () => {
    mocks.list.mockResolvedValue({
      items: [mk('a', 'Safety-Prompts', 'builtin:dataset:safety-prompts', 99798)],
      total: 1,
    });
    renderTab();
    await screen.findByTestId('seed-bank-card');
    expect(screen.queryByRole('region', { name: '国标合规检测题库' })).toBeNull();
    expect(screen.queryByRole('region', { name: '对抗演练种子' })).toBeNull();
    expect(screen.getByRole('region', { name: '可选题源' })).toBeTruthy();
  });
});

describe('RunRecordsTab', () => {
  it('默认折叠，展开后可按来源类型筛选', async () => {
    mocks.list.mockResolvedValue({
      items: [
        {
          ...base,
          id: 'r1',
          name: '综合评估快照',
          source: 'comprehensive:t:x',
          isBuiltin: false,
          kind: 'run',
          questionCount: 5,
        },
        {
          ...base,
          id: 'r2',
          name: '红队快照',
          source: 'red-team',
          isBuiltin: false,
          kind: 'run',
          questionCount: 6,
        },
      ],
      total: 2,
    });
    render(
      <QueryClientProvider client={qc()}>
        <RunRecordsTab />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/由评估任务自动产生，用于追溯，通常无需管理/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: /展开运行记录（2 条）/ }));
    expect(screen.getByText('综合评估快照')).toBeTruthy();
    expect(screen.getByText('红队快照')).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('来源类型'), 'red-team');
    expect(screen.queryByText('综合评估快照')).toBeNull();
    expect(screen.getByText('红队快照')).toBeTruthy();
  });
});
