import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QuestionSetsPage } from './QuestionSetsPage';

const mocks = vi.hoisted(() => ({ list: vi.fn(), keywordCoverage: vi.fn() }));
vi.mock('@/lib/api', () => ({
  api: {
    questionSets: {
      list: mocks.list,
      riskCategories: vi.fn().mockResolvedValue({ items: [] }),
      builtinStats: vi.fn().mockResolvedValue({ categories: [] }),
      keywordCoverage: mocks.keywordCoverage,
    },
    benchmarks: { formats: vi.fn(), samples: vi.fn() },
  },
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ hasPermission: () => true }) }));
vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

function renderPage() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <QuestionSetsPage />
    </QueryClientProvider>,
  );
}

describe('QuestionSetsPage 页签重排', () => {
  it('页签：种子库、自有样本库、运行记录、关键词库；默认种子库，自有样本库带说明，按钮带提示', async () => {
    mocks.list.mockResolvedValue({ items: [], total: 0 });
    renderPage();
    const tabs = (await screen.findAllByRole('tab')).map((t) => t.textContent);
    expect(tabs.slice(0, 4)).toEqual(['种子库', '自有样本库', '运行记录', '关键词库']);
    expect(screen.getByRole('tab', { name: '种子库' }).getAttribute('aria-selected')).toBe('true');
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ kind: 'seed' }));
    expect(screen.getByRole('button', { name: /攻击种子泛化/ }).getAttribute('title')).toContain(
      '变体',
    );
    await userEvent.click(screen.getByRole('tab', { name: '自有样本库' }));
    expect(screen.getByText(/自有样本库是你自己建立/)).toBeTruthy();
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ kind: 'own' }));
  });

  it('关键词库页签：显示覆盖统计', async () => {
    mocks.list.mockResolvedValue({ items: [], total: 0 });
    mocks.keywordCoverage.mockResolvedValue({
      total: 12,
      totalMin: 10000,
      totalOk: false,
      rows: [{ key: 'A.2.a', label: 'A.2.a 民族歧视内容', count: 12, min: 100, gap: 88, ok: false, importOnly: false }],
      gaps: [],
      ok: false,
      pendingImportItems: [],
      byStatus: { approved: 12 },
      byItemStatus: { 'A.2.a': { approved: 12, pending: 0, disabled: 0 } },
    });
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: '关键词库' }));
    expect((await screen.findByText(/要求不少于 10,000/)).textContent).toMatch(/在用\s*12\s*个/);
    expect(screen.getByText('（还差 88）')).toBeTruthy();
  });
});
