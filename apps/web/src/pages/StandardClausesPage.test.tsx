import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { StandardClausesPage } from './StandardClausesPage';

const apiMock = vi.hoisted(() => ({ catalog: vi.fn(), coverage: vi.fn(), targets: vi.fn() }));
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      standards: { catalog: apiMock.catalog, coverage: apiMock.coverage },
      modelTargets: { list: apiMock.targets },
    },
  };
});

const base = {
  basisId: 'gbt45654',
  basisName: 'GB/T 45654-2025',
  kind: 'risk' as const,
  kindLabel: '风险类',
  automation: 'auto' as const,
  automationLabel: '平台自动判定',
  capabilityNote: null,
  applicability: null,
  sourceRef: '附录 A',
  hasThreshold: false,
  invalid: 0,
  note: '本次未测。',
};
const clause = (over: Record<string, unknown>) => ({
  ...base,
  id: 'x',
  ref: '附录 A',
  title: '条款',
  requirement: '要求',
  capability: 'covered' as const,
  capabilityLabel: '平台可测',
  verdict: 'not_tested' as const,
  verdictLabel: '未测',
  tested: 0,
  failed: 0,
  ...over,
});

const catalog = {
  lines: [
    {
      line: 'content',
      label: '大模型内容安全',
      basisStatement: '内容线依据说明：现行国家标准 GB/T 45654-2025。',
      bases: [{ id: 'gbt45654', code: 'GB/T 45654-2025', title: '生成式人工智能服务安全基本要求', statusLabel: '现行', statusNote: null, issuer: 'x' }],
      references: ['OWASP Top 10 for LLM Applications 2025'],
      clauses: [],
    },
    {
      line: 'agent',
      label: '智能体应用安全',
      basisStatement: '智能体线依据说明：参照在研强制性国家标准（非现行）。',
      bases: [{ id: 'agent-app-security-plan', code: null, title: '智能体应用安全基本要求', statusLabel: '在研', statusNote: '在研强制性国家标准，非现行', issuer: 'x' }],
      references: [],
      clauses: [],
    },
    {
      line: 'endpoint',
      label: '终端智能体安全',
      basisStatement: '终端线依据说明：对照 TC260-PG-20266A。',
      bases: [],
      references: [],
      clauses: [],
    },
  ],
};

const coverageFor = (line: string) => ({
  scope: { line, taskId: null, targetId: null, days: null },
  lines: [
    {
      line,
      label: line,
      validCount: line === 'content' ? 12 : 0,
      taskCount: 1,
      summary: { clauses: 4, byVerdict: { nonconform: 1, conform: 1, not_tested: 2 } },
      clauses:
        line === 'content'
          ? [
              clause({ id: 'a', title: '含民族歧视内容', ref: 'A.2 a)', verdict: 'nonconform', verdictLabel: '发现风险', tested: 12, failed: 2 }),
              clause({ id: 'b', title: '含宗教歧视内容', ref: 'A.2 b)', verdict: 'conform', verdictLabel: '未发现风险', tested: 30 }),
              clause({ id: 'c', title: '侵犯商业秘密', ref: 'A.4 a)' }),
              clause({
                id: 'd',
                title: '特定服务类型需求',
                capability: 'not_covered',
                capabilityLabel: '平台暂不覆盖',
                capabilityNote: '需要被测方提供业务材料。',
              }),
            ]
          : [clause({ id: 'g1', title: '高风险操作人工介入', capability: 'partial', capabilityLabel: '部分可测' })],
    },
  ],
});

function renderPage(url = '/reports/standard-clauses') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/reports/standard-clauses" element={<StandardClausesPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('国内标准条款页', () => {
  beforeEach(() => {
    apiMock.catalog.mockReset().mockResolvedValue(catalog);
    apiMock.coverage.mockReset().mockImplementation((q: { line: string }) => Promise.resolve(coverageFor(q.line)));
    apiMock.targets.mockReset().mockResolvedValue({ items: [{ id: 'g1', name: '目标甲' }], total: 1, page: 1, pageSize: 100 });
  });

  it('默认是内容安全页签：顶部有依据说明，表头五列齐全', async () => {
    renderPage();
    expect(await screen.findByText(/内容线依据说明/)).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['内容安全', '智能体', '终端']);
    expect(screen.getByRole('tab', { name: '内容安全' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/国际框架（参考）：OWASP/)).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map((c) => c.textContent)).toEqual([
      '条款',
      '内容',
      '平台能力',
      '本范围结论',
      '有效判定数',
    ]);
    expect(apiMock.coverage).toHaveBeenCalledWith({ line: 'content', taskId: undefined, targetId: undefined, days: undefined });
  });

  it('未测与暂不覆盖用虚线空心标签，和已测结论实心标签区分开', async () => {
    renderPage();
    const badge = async (id: string) =>
      within(await screen.findByTestId(`clause-${id}`)).getByText(/./, { selector: '[data-state]' });
    expect(await badge('a')).toHaveTextContent('发现风险');
    expect(await badge('b')).toHaveTextContent('未发现风险');
    for (const id of ['a', 'b']) expect((await badge(id)).className).not.toMatch(/border-dashed/);
    expect(await badge('c')).toHaveTextContent('未测');
    expect((await badge('c')).className).toMatch(/border-dashed/);
    expect(await badge('d')).toHaveTextContent('暂不覆盖');
    expect((await badge('d')).className).toMatch(/border-dashed/);
    expect(within(screen.getByTestId('clause-a')).getByText(/2 项不合格/)).toBeInTheDocument();
    expect(within(screen.getByTestId('clause-d')).getByText('平台暂不覆盖')).toBeInTheDocument();
  });

  it('点击条款展开能力说明、测法与出处', async () => {
    renderPage();
    await userEvent.click(await screen.findByTestId('clause-d'));
    const detail = screen.getByTestId('detail-d');
    expect(within(detail).getByText(/需要被测方提供业务材料/)).toBeInTheDocument();
    expect(within(detail).getByText(/测法：平台自动判定/)).toBeInTheDocument();
    expect(within(detail).getByText(/出处：附录 A/)).toBeInTheDocument();
  });

  it('切到智能体、终端页签时换依据说明并重新请求该线', async () => {
    renderPage();
    await screen.findByTestId('clause-a');
    await userEvent.click(screen.getByRole('tab', { name: '智能体' }));
    expect(await screen.findByText(/参照在研强制性国家标准（非现行）/)).toBeInTheDocument();
    expect(await screen.findByTestId('clause-g1')).toBeInTheDocument();
    expect(apiMock.coverage).toHaveBeenLastCalledWith({ line: 'agent', taskId: undefined, targetId: undefined, days: undefined });
    await userEvent.click(screen.getByRole('tab', { name: '终端' }));
    expect(await screen.findByText(/对照 TC260-PG-20266A/)).toBeInTheDocument();
  });

  it('评估对象与时间窗筛选会带参重新请求', async () => {
    renderPage('/reports/standard-clauses?line=agent');
    await screen.findByTestId('clause-g1');
    await userEvent.selectOptions(screen.getByLabelText('时间窗'), '30');
    await waitFor(() =>
      expect(apiMock.coverage).toHaveBeenLastCalledWith({ line: 'agent', taskId: undefined, targetId: undefined, days: 30 }),
    );
    await userEvent.selectOptions(await screen.findByLabelText('评估对象'), 'g1');
    await waitFor(() =>
      expect(apiMock.coverage).toHaveBeenLastCalledWith({ line: 'agent', taskId: undefined, targetId: 'g1', days: 30 }),
    );
  });

  it('带 taskId 进入时只统计该任务，可回到全部任务', async () => {
    renderPage('/reports/standard-clauses?taskId=t1');
    await screen.findByTestId('clause-a');
    expect(apiMock.coverage).toHaveBeenCalledWith({ line: 'content', taskId: 't1', targetId: undefined, days: undefined });
    await userEvent.click(screen.getByRole('button', { name: '查看全部任务' }));
    await waitFor(() =>
      expect(apiMock.coverage).toHaveBeenLastCalledWith({ line: 'content', taskId: undefined, targetId: undefined, days: undefined }),
    );
  });

  it('汇总行写明各结论数量与有效判定数', async () => {
    renderPage();
    const summary = await screen.findByTestId('standard-summary');
    expect(summary).toHaveTextContent('共 4 条');
    expect(summary).toHaveTextContent('发现风险或不符合 1');
    expect(summary).toHaveTextContent('未测或暂不覆盖 2');
    expect(summary).toHaveTextContent('有效判定 12 项');
  });
});
