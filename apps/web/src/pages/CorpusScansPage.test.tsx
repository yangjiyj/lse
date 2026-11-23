import { beforeEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import type { CorpusFindingView, CorpusScanView } from '@/lib/corpus-scans';
import { CorpusScansPage } from './CorpusScansPage';
import { CorpusScanDetailPage } from './CorpusScanDetailPage';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  findings: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
  exportFindings: vi.fn(),
  maskedCopy: vi.fn(),
  listSets: vi.fn(),
  perms: new Set<string>(['corpus_scan:read', 'corpus_scan:create', 'corpus_scan:export']),
  userId: 'u1',
}));

vi.mock('@/lib/corpus-scans', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/corpus-scans')>()),
  corpusScansApi: {
    list: mocks.list,
    get: mocks.get,
    findings: mocks.findings,
    create: mocks.create,
    remove: mocks.remove,
    exportFindings: mocks.exportFindings,
    maskedCopy: mocks.maskedCopy,
  },
  corpusRulesApi: { listSets: mocks.listSets },
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    hasPermission: (code: string) => mocks.perms.has(code),
    user: { id: mocks.userId },
  }),
}));

const TS = '2026-11-21T08:00:00.000Z';
const SCAN: CorpusScanView = {
  id: 'scan-1',
  fileName: 'train.jsonl',
  bytes: 2048,
  sha256: 'a'.repeat(64),
  format: 'auto',
  detectedFormat: 'alpaca',
  container: 'jsonl',
  csvColumns: null,
  ruleSet: null,
  judgeReview: false,
  judgeLimit: 200,
  status: 'COMPLETED',
  error: null,
  progressBytes: 2048,
  totalRecords: 120,
  invalidRecords: 2,
  findingCount: 7,
  storedFindings: 7,
  truncated: false,
  stats: {
    container: 'jsonl',
    detectedFormat: 'alpaca',
    totalRecords: 120,
    invalidRecords: 2,
    invalidSamples: [{ line: 5, reason: '不是合法的 JSON' }],
    schemaCounts: { alpaca: 118 },
    findingCount: 7,
    recordsWithFindings: 5,
    byCategory: { violation: 3, sensitive: 3, custom: 1 },
    bySubtype: [{ category: 'sensitive', subtype: 'id_card_cn', label: '身份证号', count: 3 }],
    regexTimeouts: 0,
  },
  judgeReviewed: 0,
  judgeNote: null,
  maskedCopyReady: true,
  filesPurgedAt: null,
  createdBy: { id: 'u1', name: '管理员' },
  createdAt: TS,
  startedAt: TS,
  finishedAt: TS,
};
const FINDING: CorpusFindingView = {
  id: 'f1',
  recordIndex: 3,
  line: 3,
  fieldPath: 'output',
  category: 'sensitive',
  subtype: 'id_card_cn',
  subtypeLabel: '身份证号',
  matchText: '110101199003071233',
  contextBefore: '身份证 ',
  contextAfter: '，谢谢',
  severity: 'HIGH',
  judgeVerdict: null,
  judgeReason: null,
};

function wrap(ui: React.ReactElement, path = '/data/corpus-scans') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <ToastProvider>
          <Routes>
            <Route path="/data/corpus-scans" element={ui} />
            <Route path="/data/corpus-scans/:id" element={<CorpusScanDetailPage />} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  Object.values(mocks).forEach((m) => typeof m === 'function' && m.mockReset());
  mocks.perms = new Set(['corpus_scan:read', 'corpus_scan:create', 'corpus_scan:export']);
  mocks.userId = 'u1';
  mocks.list.mockResolvedValue({
    items: [SCAN],
    total: 1,
    page: 1,
    pageSize: 20,
    uploadMaxBytes: 100 * 1024 * 1024,
  });
  mocks.get.mockResolvedValue(SCAN);
  mocks.findings.mockResolvedValue({ items: [FINDING], total: 1, page: 1, pageSize: 50 });
  mocks.listSets.mockResolvedValue({
    items: [
      {
        id: 'set-1',
        name: '内部规则',
        description: null,
        ruleCount: 3,
        enabledCount: 3,
        createdAt: TS,
        updatedAt: TS,
      },
    ],
  });
  mocks.create.mockResolvedValue({ id: 'scan-2', status: 'PENDING' });
});

describe('语料扫描', () => {
  it('新建：文件和选项按选择提交', async () => {
    const user = userEvent.setup();
    render(wrap(<CorpusScansPage />));
    expect(await screen.findByText('train.jsonl')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '新建扫描' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/不超过 100 MiB/)).toBeInTheDocument();
    const file = new File(['{"conversations":[{"from":"human","value":"你好"}]}\n'], 'chat.jsonl');
    await user.upload(within(dialog).getByLabelText('语料文件'), file);
    await user.selectOptions(within(dialog).getByLabelText('格式'), 'sharegpt');
    await waitFor(() =>
      expect(within(dialog).getByRole('option', { name: '内部规则' })).toBeInTheDocument(),
    );
    await user.selectOptions(within(dialog).getByLabelText('自定义规则集'), 'set-1');
    await user.click(within(dialog).getByLabelText('裁判复核'));
    const limit = within(dialog).getByLabelText('复核上限');
    await user.clear(limit);
    await user.type(limit, '50');
    await user.click(within(dialog).getByRole('button', { name: '开始扫描' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    const [sent, opts] = mocks.create.mock.calls[0]!;
    expect(sent).toBe(file);
    expect(opts).toEqual({
      format: 'sharegpt',
      ruleSetId: 'set-1',
      judgeReview: true,
      judgeLimit: 50,
      csvColumns: [],
    });
  });

  it('CSV 文件：读表头让用户选列，只提交勾选的列', async () => {
    const user = userEvent.setup();
    render(wrap(<CorpusScansPage />));
    await user.click(await screen.findByRole('button', { name: '新建扫描' }));
    const dialog = await screen.findByRole('dialog');
    await user.upload(
      within(dialog).getByLabelText('语料文件'),
      new File(['问题,回答,编号\n你好,世界,1\n'], 'qa.csv'),
    );
    const idCol = await within(dialog).findByRole('checkbox', { name: '编号' });
    expect(within(dialog).getByRole('checkbox', { name: '问题' })).toBeChecked();
    await user.click(idCol);
    await user.click(within(dialog).getByRole('button', { name: '开始扫描' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create.mock.calls[0]![1]).toMatchObject({
      format: 'auto',
      csvColumns: ['问题', '回答'],
    });
  });

  it('没有发起权限时不显示新建按钮', async () => {
    mocks.perms = new Set(['corpus_scan:read']);
    render(wrap(<CorpusScansPage />));
    expect(await screen.findByText('train.jsonl')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '新建扫描' })).not.toBeInTheDocument();
  });

  it('详情：统计卡片、命中原文不打码，按类别筛选调接口', async () => {
    const user = userEvent.setup();
    render(wrap(<CorpusScansPage />, '/data/corpus-scans/scan-1'));
    expect(await screen.findByText('110101199003071233')).toBeInTheDocument();
    expect(mocks.findings).toHaveBeenLastCalledWith('scan-1', expect.objectContaining({ page: 1 }));
    expect(mocks.findings.mock.calls[0]![1].category).toBeUndefined();
    await user.click(screen.getByRole('tab', { name: /敏感信息/ }));
    await waitFor(() =>
      expect(mocks.findings).toHaveBeenLastCalledWith(
        'scan-1',
        expect.objectContaining({ category: 'sensitive', page: 1 }),
      ),
    );
    await user.click(screen.getByRole('tab', { name: /违规内容/ }));
    await waitFor(() =>
      expect(mocks.findings).toHaveBeenLastCalledWith(
        'scan-1',
        expect.objectContaining({ category: 'violation' }),
      ),
    );
    await user.click(screen.getByRole('button', { name: '打码副本' }));
    expect(mocks.maskedCopy).toHaveBeenCalledWith('scan-1', 'train.masked.jsonl');
  });

  it('命中超过上限时提示只保存了前 50000 条', async () => {
    mocks.get.mockResolvedValue({
      ...SCAN,
      findingCount: 60_000,
      storedFindings: 50_000,
      truncated: true,
    });
    render(wrap(<CorpusScansPage />, '/data/corpus-scans/scan-1'));
    expect(await screen.findByText('命中过多，仅保存前 50000 条')).toBeInTheDocument();
  });
});

describe('语料扫描：权限和文件状态', () => {
  const other: CorpusScanView = {
    ...SCAN,
    id: 'scan-9',
    fileName: 'other.jsonl',
    createdBy: { id: 'u2', name: '别人' },
  };

  it('只有发起权限时只能删自己发起的；有管理权限时都能删', async () => {
    mocks.list.mockResolvedValue({
      items: [SCAN, other],
      total: 2,
      page: 1,
      pageSize: 20,
      uploadMaxBytes: 1,
    });
    const { unmount } = render(wrap(<CorpusScansPage />));
    expect(await screen.findByText('other.jsonl')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '删除' })).toHaveLength(1);
    unmount();
    mocks.perms = new Set(['corpus_scan:read', 'corpus_scan:manage']);
    render(wrap(<CorpusScansPage />));
    expect(await screen.findByText('other.jsonl')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '删除' })).toHaveLength(2);
  });

  it('没有导出权限时不显示导出和打码副本', async () => {
    mocks.perms = new Set(['corpus_scan:read']);
    render(wrap(<CorpusScansPage />, '/data/corpus-scans/scan-1'));
    expect(await screen.findByText('110101199003071233')).toBeInTheDocument();
    for (const name of ['导出 CSV', '导出 JSON', '打码副本']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  it('原文件已清理：不显示打码副本，导出照常；统计里的停用规则、截断、单条上限都提示', async () => {
    mocks.get.mockResolvedValue({
      ...SCAN,
      maskedCopyReady: false,
      filesPurgedAt: TS,
      stats: {
        ...SCAN.stats!,
        cappedFindings: 1200,
        disabledRules: [{ ruleId: 'r1', pattern: '(x|x)*y', category: '慢' }],
        regexTruncatedFields: 3,
        regexRulesIgnored: 0,
      },
    });
    render(wrap(<CorpusScansPage />, '/data/corpus-scans/scan-1'));
    expect(await screen.findByText('原文件已清理')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '打码副本' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导出 CSV' })).toBeInTheDocument();
    expect(screen.getByText('规则「(x|x)*y」超时已停用')).toBeInTheDocument();
    expect(screen.getByText(/3 个字段超过 10 万字/)).toBeInTheDocument();
    expect(screen.getByText(/只计数：\s*1,200 条/)).toBeInTheDocument();
  });
});
