import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components/ui/toast';
import type { CorpusRuleSetView, CorpusRuleView } from '@/lib/corpus-scans';
import { CorpusRulesPage } from './CorpusRulesPage';

const mocks = vi.hoisted(() => ({
  listSets: vi.fn(),
  createSet: vi.fn(),
  updateSet: vi.fn(),
  deleteSet: vi.fn(),
  listRules: vi.fn(),
  createRule: vi.fn(),
  updateRule: vi.fn(),
  deleteRule: vi.fn(),
  importRules: vi.fn(),
  perms: new Set<string>(['corpus_scan:read']),
}));

vi.mock('@/lib/corpus-scans', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/corpus-scans')>()),
  corpusRulesApi: {
    listSets: mocks.listSets,
    createSet: mocks.createSet,
    updateSet: mocks.updateSet,
    deleteSet: mocks.deleteSet,
    listRules: mocks.listRules,
    createRule: mocks.createRule,
    updateRule: mocks.updateRule,
    deleteRule: mocks.deleteRule,
    importRules: mocks.importRules,
  },
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: (code: string) => mocks.perms.has(code) }),
}));

const TS = '2026-11-21T08:00:00.000Z';
const SET: CorpusRuleSetView = {
  id: 'set-1',
  name: '内部规则',
  description: null,
  ruleCount: 2,
  enabledCount: 1,
  createdAt: TS,
  updatedAt: TS,
};
const RULES: CorpusRuleView[] = [
  {
    id: 'r1',
    ruleSetId: 'set-1',
    kind: 'keyword',
    pattern: '内部资料',
    category: '涉密',
    severity: 'HIGH',
    enabled: true,
    createdAt: TS,
    updatedAt: TS,
  },
  {
    id: 'r2',
    ruleSetId: 'set-1',
    kind: 'regex',
    pattern: 'PRJ-\\d{3}',
    category: '项目代号',
    severity: 'MEDIUM',
    enabled: false,
    createdAt: TS,
    updatedAt: TS,
  },
];

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <CorpusRulesPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.values(mocks).forEach((m) => typeof m === 'function' && m.mockReset());
  mocks.listSets.mockResolvedValue({ items: [SET] });
  mocks.listRules.mockResolvedValue({ items: RULES, total: 2, page: 1, pageSize: 50 });
  mocks.updateRule.mockResolvedValue({ ...RULES[1], enabled: true });
});

describe('语料规则', () => {
  it('没有 corpus_rule:manage 时只能看，编辑类按钮都不出现', async () => {
    mocks.perms = new Set(['corpus_scan:read']);
    renderPage();
    expect(await screen.findByText('内部资料')).toBeInTheDocument();
    expect(screen.getByText('PRJ-\\d{3}')).toBeInTheDocument();
    for (const name of [
      '新建规则集',
      '新增规则',
      '导入',
      '编辑',
      '删除',
      '启用',
      '停用',
      '删除规则集',
    ]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  it('有 corpus_rule:manage 时可以启停规则', async () => {
    mocks.perms = new Set(['corpus_scan:read', 'corpus_rule:manage']);
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByRole('button', { name: '新建规则集' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '导入' })).toBeInTheDocument();
    const row = (await screen.findByText('PRJ-\\d{3}')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: '启用' }));
    await waitFor(() => expect(mocks.updateRule).toHaveBeenCalledWith('r2', { enabled: true }));
  });
});
