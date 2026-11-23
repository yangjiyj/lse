import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { JobItemEditor, normalizeJobItemParams } from './JobItemEditor';

// JobItemEditor 受控、内置引擎、评估对象和语料的可选范围、后端字段问题。
const mocks = vi.hoisted(() => ({
  targets: vi.fn(),
  sets: vi.fn(),
  engines: vi.fn(),
  scans: vi.fn(),
  ruleSets: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...orig,
    api: {
      ...orig.api,
      modelTargets: {
        list: mocks.targets,
        capabilities: vi.fn().mockResolvedValue({ platformAppEnabled: false }),
      },
      questionSets: { list: mocks.sets },
      engines: { list: mocks.engines },
    },
    assetDiscoveryApi: { scope: vi.fn().mockResolvedValue({ entries: [], ports: [] }) },
    modelFilesApi: {
      config: vi.fn().mockResolvedValue({ rootDetails: [{ path: '/models', hostPath: null }] }),
      browse: vi.fn().mockResolvedValue({
        path: '/models',
        hostPath: null,
        directories: [],
        directoryTotal: 0,
        modelFiles: [],
        modelFileTotal: 0,
        fileCount: 0,
        otherFileCount: 0,
        truncated: false,
        scanLimited: false,
        limit: 200,
      }),
      library: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 }),
    },
  };
});
vi.mock('@/lib/corpus-scans', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/corpus-scans')>()),
  corpusScansApi: { list: mocks.scans },
  corpusRulesApi: { listSets: mocks.ruleSets },
}));

let client: QueryClient;
const wrap = (node: ReactNode) => <QueryClientProvider client={client}>{node}</QueryClientProvider>;

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mocks.targets.mockResolvedValue({
    items: [
      { id: 'm1', name: '普通模型', targetType: 'MODEL', isActive: true },
      { id: 'e1', name: '终端智能体', targetType: 'ENDPOINT_AGENT', isActive: true },
      { id: 'a1', name: '公开智能体', targetType: 'PUBLIC_AGENT', isActive: true },
      { id: 'd1', name: '停用模型', targetType: 'MODEL', isActive: false },
    ],
    total: 4,
    page: 1,
    pageSize: 100,
  });
  mocks.sets.mockResolvedValue({
    items: [{ id: 'q1', name: '题库一', enabled: true, kind: 'custom' }],
    total: 1,
    page: 1,
    pageSize: 100,
  });
  mocks.engines.mockResolvedValue([
    { engine: 'rule-judge', builtin: true, available: true },
    { engine: 'sensitive-info', builtin: true, available: true },
    { engine: 'llm-judge', builtin: false, available: true },
  ]);
  mocks.scans.mockResolvedValue({
    items: [
      { id: 's1', fileName: '还在的语料.csv', filesPurgedAt: null, status: 'COMPLETED' },
      {
        id: 's2',
        fileName: '已清理的语料.csv',
        filesPurgedAt: '2026-11-01T00:00:00Z',
        status: 'COMPLETED',
      },
    ],
    total: 2,
    page: 1,
    pageSize: 100,
    uploadMaxBytes: 1,
  });
  mocks.ruleSets.mockResolvedValue({ items: [] });
});

describe('JobItemEditor', () => {
  it('受控：父组件换了值，资产测绘的目标和端口文本跟着变；自己输入时不被打断', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const view = render(
      wrap(
        <JobItemEditor
          kind="asset_discovery"
          value={{ targets: ['10.0.0.1'], ports: [80], confirm: true }}
          onChange={onChange}
        />,
      ),
    );
    view.rerender(
      wrap(
        <JobItemEditor
          kind="asset_discovery"
          value={{ targets: ['192.168.1.0/24'], ports: [443], confirm: true }}
          onChange={onChange}
        />,
      ),
    );
    expect(screen.getByLabelText(/扫描目标/)).toHaveValue('192.168.1.0/24');
    expect(screen.getByLabelText(/端口/)).toHaveValue('443');
    // 输入「443, 」：发出的规范值仍是 [443]，父组件回传同样的值，文本不被重置
    await user.type(screen.getByLabelText(/端口/), ', ');
    const [params] = onChange.mock.calls.at(-1)!;
    view.rerender(
      wrap(<JobItemEditor kind="asset_discovery" value={params} onChange={onChange} />),
    );
    expect(screen.getByLabelText(/端口/)).toHaveValue('443, ');
  });

  it('评估对象只列内容评估能用的（不列终端智能体、公开智能体、停用的）', async () => {
    render(
      wrap(
        <JobItemEditor
          kind="eval_task"
          value={{ modelTargetId: '', questionSetIds: [], engines: [] }}
          onChange={vi.fn()}
        />,
      ),
    );
    const select = screen.getByLabelText(/评估对象/);
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(2));
    expect(within(select).getByRole('option', { name: '普通模型' })).toBeInTheDocument();
  });

  it('内置引擎显示勾选，发出的 engines 里也有', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      wrap(
        <JobItemEditor
          kind="eval_task"
          value={{ modelTargetId: 'm1', questionSetIds: ['q1'], engines: [] }}
          onChange={onChange}
        />,
      ),
    );
    const group = await screen.findByRole('group', { name: '安全引擎' });
    const required = await within(group).findByRole('checkbox', { name: '规则引擎' });
    expect(required).toBeChecked();
    expect(required).toBeDisabled();
    await user.click(within(group).getByRole('checkbox', { name: 'AI 评审复核' }));
    const [params, problem] = onChange.mock.calls.at(-1)!;
    expect([...params.engines].sort()).toEqual(['llm-judge', 'rule-judge', 'sensitive-info']);
    expect(problem).toBeNull();
    expect(normalizeJobItemParams('eval_task', { engines: ['llm-judge'] }).engines).toEqual([
      'rule-judge',
      'sensitive-info',
      'llm-judge',
    ]);
  });

  it('语料重扫不列原文件已清理的扫描', async () => {
    render(
      wrap(
        <JobItemEditor
          kind="corpus_scan"
          value={{ sourceScanId: '', ruleSetId: null }}
          onChange={vi.fn()}
        />,
      ),
    );
    expect(await screen.findByRole('option', { name: '还在的语料.csv' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '已清理的语料.csv' })).toBeNull();
  });

  it('后端指出的字段问题显示在对应字段下', () => {
    render(
      wrap(
        <JobItemEditor
          kind="asset_discovery"
          value={{ targets: ['10.0.0.0/33'], ports: [443], confirm: true }}
          onChange={vi.fn()}
          issues={[{ path: 'targets', message: '目标格式不正确：10.0.0.0/33' }]}
        />,
      ),
    );
    expect(screen.getByText('目标格式不正确：10.0.0.0/33')).toBeInTheDocument();
  });

  it('样本库：已选的排在前面，标签上显示已选几个', async () => {
    mocks.sets.mockResolvedValue({
      items: [
        { id: 'q1', name: '题库一', enabled: true, kind: 'custom' },
        { id: 'q2', name: '题库二', enabled: true, kind: 'custom' },
      ],
      total: 2,
      page: 1,
      pageSize: 100,
    });
    render(
      wrap(
        <JobItemEditor
          kind="eval_task"
          value={{ modelTargetId: 'm1', questionSetIds: ['q2'], engines: [] }}
          onChange={vi.fn()}
        />,
      ),
    );
    const group = await screen.findByRole('group', { name: '样本库' });
    await within(group).findByText('题库二');
    const boxes = within(group).getAllByRole('checkbox');
    expect(boxes[0]).toBeChecked();
    expect(boxes[0]!.closest('label')).toHaveTextContent('题库二');
    expect(screen.getByText('样本库（已选 1 个）')).toBeInTheDocument();
  });

  it('模型文件：选目录时路径只显示一遍', async () => {
    render(
      wrap(
        <JobItemEditor
          kind="model_file_scan"
          value={{ source: 'directory', path: '' }}
          onChange={vi.fn()}
        />,
      ),
    );
    expect(await screen.findByRole('button', { name: '选择此目录' })).toBeInTheDocument();
    expect(screen.getAllByText('/models')).toHaveLength(1);
    expect(screen.queryByText(/目录：/)).toBeNull();
  });
});
