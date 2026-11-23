import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { ToastProvider } from '@/components/ui/toast';
import { ModelFileScanPage } from './ModelFileScanPage';
import { modelFilesApi } from '@/lib/api';

const perms = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: (code: string) => perms.granted.has(code) }),
}));

const GiB = 1024 ** 3;

const { ApiErrorMock, config, browseRoot, browseLlama, browseEmpty } = vi.hoisted(() => {
  class ApiErrorMock extends Error {
    status: number;
    code?: string;
    issues?: unknown;
    constructor(message: string, status = 400, code?: string, issues?: unknown) {
      super(message);
      this.status = status;
      this.code = code;
      this.issues = issues;
    }
  }
  const GiB = 1024 ** 3;
  const TiB = 1024 ** 4;
  const config = {
    roots: ['/data/extra'],
    envRoots: ['/models'],
    hostDir: '/srv/lse-models',
    pickleMaxBytes: 512 * 1024 * 1024,
    totalMaxBytes: TiB,
    maxFiles: 10_000,
    uploadMaxBytes: 2 * GiB,
    limitBounds: {
      pickleMaxBytes: { min: 1024, max: 8 * GiB },
      totalMaxBytes: { min: 1024, max: 16 * TiB },
      maxFiles: { min: 1, max: 100_000 },
    },
    ignoredRoots: [],
    rootDetails: [
      {
        path: '/models',
        hostPath: '/srv/lse-models',
        source: 'deploy',
        exists: true,
        readable: true,
        problem: null,
      },
      {
        path: '/data/extra',
        hostPath: null,
        source: 'admin',
        exists: true,
        readable: true,
        problem: null,
      },
    ],
  };
  const listing = (path: string, over: Record<string, unknown>) => ({
    path,
    hostPath: path.startsWith('/models') ? `/srv/lse-models${path.slice('/models'.length)}` : null,
    directories: [],
    directoryTotal: 0,
    modelFiles: [],
    modelFileTotal: 0,
    fileCount: 0,
    otherFileCount: 0,
    truncated: false,
    scanLimited: false,
    limit: 500,
    ...over,
  });
  return {
    ApiErrorMock,
    config,
    browseRoot: listing('/models', {
      directories: ['llama', 'qwen'],
      directoryTotal: 2,
      modelFiles: [
        { name: 'tiny.safetensors', bytes: 2048, modifiedAt: '2026-10-01T08:00:00.000Z' },
      ],
      modelFileTotal: 1,
      fileCount: 3,
      otherFileCount: 2,
    }),
    browseLlama: listing('/models/llama', {
      directories: ['7b'],
      directoryTotal: 1,
      modelFiles: [{ name: 'model.gguf', bytes: 5 * GiB, modifiedAt: '2026-10-02T09:30:00.000Z' }],
      modelFileTotal: 1,
      fileCount: 1,
    }),
    browseEmpty: listing('/models/qwen', {}),
  };
});

vi.mock('@/lib/api', () => ({
  ApiError: ApiErrorMock,
  api: {
    modelTargets: {
      list: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 }),
    },
  },
  modelFilesApi: {
    library: vi
      .fn()
      .mockResolvedValue({
        items: [],
        total: 0,
        page: 1,
        pageSize: 20,
        diskFreeBytes: 100 * 1024 ** 3,
        libraryBytes: 0,
      }),
    config: vi.fn(),
    updateConfig: vi.fn(),
    browse: vi.fn(),
    scanDirectory: vi.fn(),
    scanUpload: vi.fn(),
    stageUpload: vi.fn(),
    list: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 }),
    get: vi.fn(),
    findings: vi.fn(),
    scriptRisks: vi.fn().mockResolvedValue({ groups: [] }),
    rules: vi.fn().mockResolvedValue({ total: 0, items: [] }),
    exportAibom: vi.fn(),
    cancel: vi.fn(),
  },
}));

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>{node}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function grant(...codes: string[]) {
  perms.granted = new Set(codes);
}

async function openDirectoryTab() {
  fireEvent.click(await screen.findByRole('tab', { name: '目录扫描' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  grant('engine:scan', 'platform_setting:update');
  vi.mocked(modelFilesApi.config).mockResolvedValue(structuredClone(config) as never);
  vi.mocked(modelFilesApi.browse).mockImplementation((async (path: string) => {
    if (path === '/models') return structuredClone(browseRoot);
    if (path === '/models/llama') return structuredClone(browseLlama);
    if (path === '/models/qwen') return structuredClone(browseEmpty);
    if (path === '/data/extra') return { ...structuredClone(browseEmpty), path: '/data/extra' };
    throw new ApiErrorMock('该目录不在允许扫描的范围内', 400);
  }) as never);
  vi.mocked(modelFilesApi.list).mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 10,
  } as never);
});

describe('目录浏览：面包屑 + 列表', () => {
  it('显示根目录、面包屑与表格，目录在前、模型文件在后，带类型/大小/修改时间', async () => {
    wrap(<ModelFileScanPage />);
    await openDirectoryTab();
    const table = await screen.findByRole('table', { name: '当前目录内容' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual([
      expect.stringContaining('llama'),
      expect.stringContaining('qwen'),
      expect.stringContaining('tiny.safetensors'),
    ]);
    expect(within(rows[0]!).getByText('目录')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('模型文件')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('2 KiB')).toBeInTheDocument();
    expect(within(rows[2]!).getByText(/2026-10-01/)).toBeInTheDocument();
    expect(within(rows[0]!).getAllByText('—')).toHaveLength(2);
    expect(screen.getByRole('navigation', { name: '目录路径' })).toBeInTheDocument();
  });

  it('列表区域够高：至少能同时看到十几行，超出滚动', async () => {
    wrap(<ModelFileScanPage />);
    await openDirectoryTab();
    const box = await screen.findByTestId('dir-list');
    expect(box.className).toMatch(/max-h-\[(?:[3-9]\d{2}|\d{4,})px\]/);
    expect(box.className).toMatch(/overflow-y-auto/);
  });

  it('点进目录后面包屑追加一段，点面包屑可回退到任意一级', async () => {
    const user = userEvent.setup();
    wrap(<ModelFileScanPage />);
    await openDirectoryTab();
    await user.click(await screen.findByRole('button', { name: '进入目录 llama' }));
    const nav = await screen.findByRole('navigation', { name: '目录路径' });
    expect(await within(nav).findByText('llama')).toHaveAttribute('aria-current', 'page');
    expect(modelFilesApi.browse).toHaveBeenLastCalledWith('/models/llama');
    expect(await screen.findByText('model.gguf')).toBeInTheDocument();
    await user.click(within(nav).getByRole('button', { name: '回到 /models' }));
    expect(await screen.findByRole('button', { name: '进入目录 qwen' })).toBeInTheDocument();
    await waitFor(() => expect(modelFilesApi.browse).toHaveBeenLastCalledWith('/models'));
  });

  it('模型文件只展示，不能点进去', async () => {
    wrap(<ModelFileScanPage />);
    await openDirectoryTab();
    await screen.findByText('tiny.safetensors');
    expect(screen.queryByRole('button', { name: /进入目录 tiny/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /tiny/ })).not.toBeInTheDocument();
  });

  it('扫描按钮固定在列表上方，旁边写明服务器路径与容器内路径，并按当前目录发起扫描', async () => {
    const user = userEvent.setup();
    vi.mocked(modelFilesApi.scanDirectory).mockResolvedValue({
      id: 's1',
      status: 'PENDING',
    } as never);
    // 提交成功后页面会自动打开这条扫描的明细，需要给明细接口一个返回值
    vi.mocked(modelFilesApi.get).mockResolvedValue({
      id: 's1',
      source: 'DIRECTORY',
      path: '/models/llama',
      status: 'PENDING',
      files: [],
    } as never);
    vi.mocked(modelFilesApi.findings).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    } as never);
    wrap(<ModelFileScanPage />);
    await openDirectoryTab();
    await user.click(await screen.findByRole('button', { name: '进入目录 llama' }));
    const bar = await screen.findByTestId('scan-bar');
    expect(bar).toHaveTextContent('/srv/lse-models/llama');
    expect(bar).toHaveTextContent('容器内路径 /models/llama');
    await user.click(within(bar).getByRole('button', { name: '扫描当前目录' }));
    await waitFor(() =>
      expect(modelFilesApi.scanDirectory).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/models/llama' }),
      ),
    );
  });

  it('多个根目录时用下拉选择，下拉里以服务器路径为主；只有一个根时直接显示', async () => {
    const user = userEvent.setup();
    wrap(<ModelFileScanPage />);
    await openDirectoryTab();
    const select = await screen.findByRole('combobox', { name: '扫描根目录' });
    expect(
      within(select).getByRole('option', { name: /\/srv\/lse-models.*\/models/ }),
    ).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: /\/data\/extra/ })).toBeInTheDocument();
    await user.selectOptions(select, '/data/extra');
    await waitFor(() => expect(modelFilesApi.browse).toHaveBeenLastCalledWith('/data/extra'));
  });

  it('只有一个根目录时不出现下拉', async () => {
    vi.mocked(modelFilesApi.config).mockResolvedValue({
      ...structuredClone(config),
      roots: [],
      rootDetails: [structuredClone(config.rootDetails[0])],
    } as never);
    wrap(<ModelFileScanPage />);
    await openDirectoryTab();
    await screen.findByTestId('scan-bar');
    expect(screen.queryByRole('combobox', { name: '扫描根目录' })).not.toBeInTheDocument();
    // 根目录直接作为面包屑的第一段显示，「管理目录」跟在同一行，不再重复写一遍根路径
    expect(screen.getByRole('navigation', { name: '目录路径' })).toHaveTextContent(
      '/srv/lse-models',
    );
    expect(screen.getByRole('button', { name: '管理目录' })).toBeInTheDocument();
    expect(screen.queryByText('扫描根目录：')).not.toBeInTheDocument();
  });

  it('空目录：说明把模型放到服务器的哪个目录，不出现环境变量名', async () => {
    const user = userEvent.setup();
    wrap(<ModelFileScanPage />);
    await openDirectoryTab();
    await user.click(await screen.findByRole('button', { name: '进入目录 qwen' }));
    const hint = await screen.findByTestId('empty-dir');
    expect(hint).toHaveTextContent('把模型文件放到服务器上的 /srv/lse-models/qwen 目录');
    expect(hint).toHaveTextContent('刷新');
    expect(document.body.textContent).not.toMatch(/MODEL_SCAN|环境变量/);
  });

  it('根目录为空时：提示放到服务器的主机目录，并带刷新按钮', async () => {
    vi.mocked(modelFilesApi.browse).mockResolvedValue({
      ...structuredClone(browseEmpty),
      path: '/models',
      hostPath: '/srv/lse-models',
    } as never);
    wrap(<ModelFileScanPage />);
    await openDirectoryTab();
    expect(await screen.findByTestId('empty-dir')).toHaveTextContent('/srv/lse-models');
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() =>
      expect(vi.mocked(modelFilesApi.browse).mock.calls.length).toBeGreaterThan(1),
    );
  });

  it('子目录太多时提示只显示前 N 个，并给出总数', async () => {
    vi.mocked(modelFilesApi.browse).mockResolvedValue({
      ...structuredClone(browseRoot),
      directories: ['a', 'b'],
      directoryTotal: 1234,
      truncated: true,
      limit: 500,
    } as never);
    wrap(<ModelFileScanPage />);
    await openDirectoryTab();
    expect(await screen.findByTestId('truncated-hint')).toHaveTextContent(
      '仅显示前 500 项，共 1234 个子目录',
    );
  });

  it('列表下方的说明写明会完整读取每个文件，并给出每 100 GiB 的预计耗时', async () => {
    wrap(<ModelFileScanPage />);
    await openDirectoryTab();
    const note = await screen.findByTestId('scan-limits-note');
    expect(note).toHaveTextContent('单次扫描最多 10000 个模型文件、共 1 TiB');
    expect(note).toHaveTextContent('完整读取');
    expect(note).toHaveTextContent('每 100 GiB 约需 3 到 17 分钟');
  });

  it('目录读取失败时显示后端给的中文原因', async () => {
    vi.mocked(modelFilesApi.browse).mockRejectedValue(
      new ApiErrorMock('没有读取权限：平台进程读不了这个目录', 400),
    );
    wrap(<ModelFileScanPage />);
    await openDirectoryTab();
    expect(await screen.findByText(/没有读取权限/)).toBeInTheDocument();
  });

  it('没有任何可用目录时：说明怎么做；管理员看到「管理目录」入口，不露环境变量名', async () => {
    vi.mocked(modelFilesApi.config).mockResolvedValue({
      ...structuredClone(config),
      roots: [],
      envRoots: [],
      rootDetails: [],
    } as never);
    wrap(<ModelFileScanPage />);
    await openDirectoryTab();
    const box = await screen.findByTestId('no-roots');
    expect(box).toHaveTextContent('/srv/lse-models');
    expect(box).toHaveTextContent('管理目录');
    expect(document.body.textContent).not.toMatch(/MODEL_SCAN|环境变量|\.env/);
    expect(screen.getByRole('button', { name: '管理目录' })).toBeInTheDocument();
  });
});

describe('管理目录弹窗', () => {
  async function openDialog() {
    const user = userEvent.setup();
    wrap(<ModelFileScanPage />);
    await openDirectoryTab();
    await user.click(await screen.findByRole('button', { name: '管理目录' }));
    return { user, dialog: await screen.findByRole('dialog', { name: '管理扫描目录' }) };
  }

  it('有权限：部署目录只读并标注「部署时配置」；管理员目录可删除，并显示是否存在/可读', async () => {
    const { dialog } = await openDialog();
    const deploy = within(dialog).getByTestId('root-/models');
    expect(deploy).toHaveTextContent('/srv/lse-models');
    expect(deploy).toHaveTextContent('部署时配置');
    expect(within(deploy).queryByRole('button', { name: /删除/ })).not.toBeInTheDocument();
    expect(deploy).toHaveTextContent('可读');
    const admin = within(dialog).getByTestId('root-/data/extra');
    expect(admin).toHaveTextContent('管理员添加');
    expect(within(admin).getByRole('button', { name: '删除目录 /data/extra' })).toBeInTheDocument();
  });

  it('目录不存在或不可读时用中文标明', async () => {
    vi.mocked(modelFilesApi.config).mockResolvedValue({
      ...structuredClone(config),
      rootDetails: [
        ...structuredClone(config.rootDetails.slice(0, 1)),
        {
          path: '/data/extra',
          hostPath: null,
          source: 'admin',
          exists: false,
          readable: false,
          problem: '目录不存在',
        },
      ],
    } as never);
    const { dialog } = await openDialog();
    expect(within(dialog).getByTestId('root-/data/extra')).toHaveTextContent('目录不存在');
  });

  it('扫描上限用 GiB / 个填写，不要求填字节；保存时换算成字节', async () => {
    const { user, dialog } = await openDialog();
    expect(within(dialog).getByLabelText('单次扫描总量上限（GiB）')).toHaveValue(1024);
    expect(within(dialog).getByLabelText('单个 pickle 文件的解析上限（MiB）')).toHaveValue(512);
    expect(within(dialog).getByLabelText('单次扫描文件数上限（个）')).toHaveValue(10000);
    vi.mocked(modelFilesApi.updateConfig).mockResolvedValue(structuredClone(config) as never);
    const total = within(dialog).getByLabelText('单次扫描总量上限（GiB）');
    await user.clear(total);
    await user.type(total, '2048');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(modelFilesApi.updateConfig).toHaveBeenCalledWith({
        roots: ['/data/extra'],
        pickleMaxBytes: 512 * 1024 * 1024,
        totalMaxBytes: 2048 * GiB,
        maxFiles: 10_000,
      }),
    );
  });

  it('上限旁边说明：会完整读取每个文件，耗时取决于磁盘', async () => {
    const { dialog } = await openDialog();
    expect(within(dialog).getByTestId('limit-note')).toHaveTextContent('完整读取');
    expect(within(dialog).getByTestId('limit-note')).toHaveTextContent('磁盘');
  });

  it('上限旁边给出预计耗时，并随填写的总量变化', async () => {
    const { user, dialog } = await openDialog();
    const note = within(dialog).getByTestId('limit-note');
    expect(note).toHaveTextContent('读满上限 1 TiB 约需 35 分钟到 2.9 小时');
    const total = within(dialog).getByLabelText('单次扫描总量上限（GiB）');
    await user.clear(total);
    await user.type(total, '100');
    expect(note).toHaveTextContent('读满上限 100 GiB 约需 3 到 17 分钟');
    await user.clear(total);
    expect(note).not.toHaveTextContent('读满上限');
    expect(note).toHaveTextContent('完整读取');
  });

  it('可输入新目录并添加到列表，保存时一并提交', async () => {
    const { user, dialog } = await openDialog();
    vi.mocked(modelFilesApi.updateConfig).mockResolvedValue(structuredClone(config) as never);
    await user.type(within(dialog).getByLabelText('添加目录'), '/mnt/nas/models');
    await user.click(within(dialog).getByRole('button', { name: '添加' }));
    expect(within(dialog).getByTestId('root-/mnt/nas/models')).toHaveTextContent('待保存');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(modelFilesApi.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ roots: ['/data/extra', '/mnt/nas/models'] }),
      ),
    );
  });

  it('删除管理员目录后保存时不再提交该目录', async () => {
    const { user, dialog } = await openDialog();
    vi.mocked(modelFilesApi.updateConfig).mockResolvedValue(structuredClone(config) as never);
    await user.click(within(dialog).getByRole('button', { name: '删除目录 /data/extra' }));
    expect(within(dialog).queryByTestId('root-/data/extra')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(modelFilesApi.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ roots: [] }),
      ),
    );
  });

  it('保存失败：就地显示后端给的中文原因，并指出是哪个目录', async () => {
    const { user, dialog } = await openDialog();
    vi.mocked(modelFilesApi.updateConfig).mockRejectedValue(
      new ApiErrorMock('/etc：属于系统目录，不允许加入', 400, 'MODEL_FILE_ROOT_INVALID', {
        rejected: [{ path: '/etc', reason: '属于系统目录，不允许加入' }],
      }),
    );
    await user.type(within(dialog).getByLabelText('添加目录'), '/etc');
    await user.click(within(dialog).getByRole('button', { name: '添加' }));
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    const row = await within(dialog).findByTestId('root-/etc');
    expect(row).toHaveTextContent('属于系统目录，不允许加入');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('/etc');
    expect(screen.getByRole('dialog', { name: '管理扫描目录' })).toBeInTheDocument();
  });

  it('保存失败且不是针对某个目录（如上限越界）：在弹窗里显示原因', async () => {
    const { user, dialog } = await openDialog();
    vi.mocked(modelFilesApi.updateConfig).mockRejectedValue(
      new ApiErrorMock('「单次扫描总量上限」超出范围，请填写 1 KiB 到 16 TiB 之间的数值', 400),
    );
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('超出范围');
  });

  it('保存成功后关闭弹窗并刷新目录列表', async () => {
    const { user, dialog } = await openDialog();
    vi.mocked(modelFilesApi.updateConfig).mockResolvedValue(structuredClone(config) as never);
    const calls = vi.mocked(modelFilesApi.config).mock.calls.length;
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '管理扫描目录' })).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(vi.mocked(modelFilesApi.config).mock.calls.length).toBeGreaterThan(calls),
    );
  });

  it('弹窗里有一句边界说明：只能看到部署时挂载进来的目录，并给出做法', async () => {
    const { dialog } = await openDialog();
    const note = within(dialog).getByTestId('boundary-note');
    expect(note).toHaveTextContent('只能看到部署时挂载进来的目录');
    expect(note).toHaveTextContent('/srv/lse-models');
    expect(note).toHaveTextContent('只读挂载');
  });

  it('没有 platform_setting:update 权限：看不到「管理目录」按钮，只看到只读说明', async () => {
    grant('engine:scan');
    wrap(<ModelFileScanPage />);
    await openDirectoryTab();
    await screen.findByTestId('scan-bar');
    expect(screen.queryByRole('button', { name: '管理目录' })).not.toBeInTheDocument();
    expect(screen.getByTestId('readonly-roots')).toHaveTextContent('如需增加目录请联系管理员');
  });
});

describe('页面', () => {
  it('页面底部原来的「扫描配置（管理员）」区块已移除，只剩一个入口', async () => {
    wrap(<ModelFileScanPage />);
    await screen.findByRole('heading', { name: '模型文件扫描' });
    expect(screen.queryByText('扫描配置（管理员）')).not.toBeInTheDocument();
    expect(screen.queryByText('白名单根目录与扫描体量上限。')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('白名单根目录')).not.toBeInTheDocument();
    await openDirectoryTab();
    expect(await screen.findAllByRole('button', { name: '管理目录' })).toHaveLength(1);
  });

  it('文件库说明文件保留与目录扫描入口，不出现上传限制或环境变量名', async () => {
    wrap(<ModelFileScanPage />);
    expect(
      await screen.findByText(/上传的文件保存在服务器上，可随时扫描或删除/),
    ).toBeInTheDocument();
    expect(await screen.findByText(/服务器磁盘剩余 100 GiB/)).toBeInTheDocument();
    expect(screen.getByText(/也可以用「目录扫描」/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/上传上限|更大的模型请放/);
    expect(document.body.textContent).not.toMatch(/MODEL_SCAN|环境变量/);
  });

  it('部分结果的提示不再指向已移除的「扫描配置」', async () => {
    const scan = {
      id: 's9',
      source: 'DIRECTORY',
      path: '/models',
      targetId: null,
      target: null,
      status: 'COMPLETED',
      error: null,
      fileCount: 1,
      totalBytes: 2048,
      skippedCount: 0,
      highCount: 0,
      mediumCount: 0,
      lowCount: 0,
      hasAibom: true,
      createdBy: null,
      createdAt: '2026-10-23T00:00:00.000Z',
      progressFiles: 1,
      progressBytes: 2048,
      plannedFiles: 1,
      plannedBytes: 2048,
      truncatedCount: 3,
      truncatedReason: '扫描内容超过总量上限 1 TiB',
      startedAt: null,
      finishedAt: null,
      files: [],
    };
    vi.mocked(modelFilesApi.list).mockResolvedValue({
      items: [scan],
      total: 1,
      page: 1,
      pageSize: 10,
    } as never);
    vi.mocked(modelFilesApi.get).mockResolvedValue(scan as never);
    vi.mocked(modelFilesApi.findings).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    } as never);
    wrap(<ModelFileScanPage />);
    fireEvent.click(await screen.findByText('查看明细'));
    const hint = await screen.findByText(/部分结果：/);
    expect(hint.textContent).toMatch(/管理目录/);
    expect(hint.textContent).not.toMatch(/「扫描配置」/);
  });
});
