import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOL_TASK_ENTRIES } from '@lse/shared';
import { ToastProvider } from '@/components/ui/toast';
import type { ToolDetail } from '@/lib/tools';
import { ToolDetailPage } from './ToolDetailPage';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  download: vi.fn(),
  downloadVersion: vi.fn(),
  downloads: vi.fn(),
  perms: new Set<string>(['tool:read']),
}));

vi.mock('@/lib/tools', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tools')>()),
  toolsApi: {
    get: mocks.get,
    update: mocks.update,
    download: mocks.download,
    downloadVersion: mocks.downloadVersion,
    downloads: mocks.downloads,
  },
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: (code: string) => mocks.perms.has(code) }),
}));

const TS = '2026-11-21T08:00:00.000Z';
const TOOL: ToolDetail = {
  id: 't1',
  code: 'model-scanner',
  name: '模型扫描器',
  category: 'model',
  description: '扫描模型文件',
  taskEntry: 'model-file-scan',
  task: TOOL_TASK_ENTRIES['model-file-scan'],
  enabled: true,
  hidden: false,
  builtin: false,
  latestVersion: { version: '1.2.0', createdAt: TS },
  platforms: [{ os: 'linux', arch: 'amd64' }],
  versionCount: 1,
  downloadCount: 3,
  createdAt: TS,
  updatedAt: TS,
  instructions: '第一段第一行\n第一段第二行\n\n<b>第二段</b>',
  configParams: [
    {
      name: 'dir',
      label: '扫描目录',
      description: '模型所在目录',
      defaultValue: '/models',
      required: true,
    },
  ],
  createdBy: { id: 'u1', username: 'admin' },
  versions: [
    {
      id: 'v1',
      version: '1.2.0',
      os: 'linux',
      arch: 'amd64',
      filename: 'scanner.tar.gz',
      size: 2048,
      sha256: 'a'.repeat(64),
      releaseNotes: '',
      createdAt: TS,
      createdBy: { id: 'u1', username: 'admin' },
      downloadUrl: '/api/tools/t1/versions/v1/download',
    },
  ],
  manuals: [
    {
      id: 'm1',
      title: '使用手册',
      filename: 'guide.pdf',
      size: 1024,
      sha256: 'b'.repeat(64),
      mime: 'application/pdf',
      createdAt: TS,
      updatedAt: TS,
      createdBy: null,
      downloadUrl: '/api/tools/t1/manuals/m1/download',
    },
  ],
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/tools/t1']}>
          <Routes>
            <Route path="/tools/:id" element={<ToolDetailPage />} />
            <Route path="/inspect/model-files" element={<p>模型文件扫描页</p>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('ToolDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.perms = new Set(['tool:read']);
    mocks.get.mockResolvedValue(TOOL);
    mocks.download.mockResolvedValue(undefined);
    mocks.downloadVersion.mockResolvedValue(undefined);
    mocks.downloads.mockResolvedValue({ total: 0, byUser: [], trend: [], recent: [] });
  });

  it('操作说明按纯文本分段显示，不渲染 HTML；配置参数、版本、手册都列出来', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: '模型扫描器' })).toBeInTheDocument();
    expect(screen.getByText(/第一段第一行/)).toHaveTextContent('第一段第一行 第一段第二行');
    expect(screen.getByText('<b>第二段</b>')).toBeInTheDocument();
    expect(screen.getByText('扫描目录')).toBeInTheDocument();
    expect(screen.getByText('scanner.tar.gz')).toBeInTheDocument();
    expect(screen.getByText('使用手册')).toBeInTheDocument();
  });

  it('「新建任务」跳到白名单里的 createPath', async () => {
    mocks.perms = new Set(['tool:read', 'engine:scan']);
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /新建任务/ }));
    expect(await screen.findByText('模型文件扫描页')).toBeInTheDocument();
  });

  it('版本走一次性下载链接（浏览器原生下载），手册按接口给的地址下载', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /下载 1\.2\.0/ }));
    expect(mocks.downloadVersion).toHaveBeenCalledWith('t1', 'v1');
    expect(mocks.download).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /下载手册 使用手册/ }));
    expect(mocks.download).toHaveBeenCalledWith('/api/tools/t1/manuals/m1/download', 'guide.pdf');
  });

  it('内置探针的一键包仍按 /api/fleet/kits 地址下载', async () => {
    mocks.get.mockResolvedValue({
      ...TOOL,
      builtin: true,
      versions: [
        {
          ...TOOL.versions[0]!,
          id: 'kit-linux-amd64',
          filename: 'linux-amd64.tar.gz',
          downloadUrl: '/api/fleet/kits/linux-amd64.tar.gz',
        },
      ],
    });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /下载 1\.2\.0/ }));
    expect(mocks.download).toHaveBeenCalledWith(
      '/api/fleet/kits/linux-amd64.tar.gz',
      'linux-amd64.tar.gz',
    );
    expect(mocks.downloadVersion).not.toHaveBeenCalled();
  });

  it('没有目标模块的新建权限：「新建任务」置灰并提示，「任务列表」照常', async () => {
    renderPage();
    const create = await screen.findByRole('button', { name: /新建任务/ });
    expect(create).toBeDisabled();
    expect(create).toHaveAttribute('title', '没有新建权限');
    expect(screen.getByRole('button', { name: /任务列表/ })).toBeEnabled();
  });

  it('禁用的工具：下载和新建任务、任务列表置灰', async () => {
    mocks.get.mockResolvedValue({ ...TOOL, enabled: false });
    renderPage();
    expect(await screen.findByText('已禁用')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /下载 1\.2\.0/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /新建任务/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /任务列表/ })).toBeDisabled();
  });

  it('没有 tool:manage 时不出现管理按钮和下载记录', async () => {
    renderPage();
    await screen.findByRole('heading', { name: '模型扫描器' });
    for (const name of [/编辑/, /上传版本/, /上传手册/, /^禁用$/, /^隐藏$/, /删除/, /替换/])
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    expect(screen.queryByText('下载记录')).not.toBeInTheDocument();
    expect(mocks.downloads).not.toHaveBeenCalled();
  });

  it('有 tool:manage 时出现管理按钮和下载记录，可以禁用', async () => {
    mocks.perms = new Set(['tool:read', 'tool:manage']);
    mocks.update.mockResolvedValue({ ...TOOL, enabled: false });
    mocks.downloads.mockResolvedValue({
      total: 2,
      byUser: [
        {
          userId: 'u2',
          username: 'operator1',
          tenantName: '默认租户',
          packages: 2,
          manuals: 0,
          total: 2,
          lastDownloadedAt: TS,
        },
      ],
      trend: [
        { date: '2026-11-20', count: 0 },
        { date: '2026-11-21', count: 2 },
      ],
      recent: [
        {
          createdAt: TS,
          username: null,
          tenantName: null,
          kind: 'package',
          filename: 'scanner-1.1.0.tar.gz',
          ip: '10.1.2.3',
        },
      ],
    });
    renderPage();
    for (const name of [/编辑/, /上传版本/, /上传手册/, /^隐藏$/, /删除版本/])
      expect(await screen.findByRole('button', { name })).toBeInTheDocument();
    expect(await screen.findByText('operator1')).toBeInTheDocument();
    expect(screen.getByTestId('download-trend')).toBeInTheDocument();
    // 下载明细看得出下载的是哪个文件
    expect(screen.getByRole('heading', { name: '下载明细' })).toBeInTheDocument();
    expect(screen.getByText('scanner-1.1.0.tar.gz')).toBeInTheDocument();
    expect(screen.getByText('10.1.2.3')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '禁用' }));
    expect(mocks.update).toHaveBeenCalledWith('t1', { enabled: false });
  });

  it('内置工具不显示禁用、删除和上传版本，非一键包引导去终端接入', async () => {
    mocks.perms = new Set(['tool:read', 'tool:manage']);
    mocks.get.mockResolvedValue({
      ...TOOL,
      builtin: true,
      task: TOOL_TASK_ENTRIES['fleet-onboard'],
      taskEntry: 'fleet-onboard',
      versions: [
        { ...TOOL.versions[0]!, id: 'kit-windows-amd64', os: 'windows', downloadUrl: null },
      ],
    });
    renderPage();
    expect(await screen.findByRole('link', { name: '去终端接入' })).toHaveAttribute(
      'href',
      TOOL_TASK_ENTRIES['fleet-onboard'].createPath,
    );
    expect(screen.queryByRole('button', { name: '禁用' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /上传版本/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^删除$/ })).not.toBeInTheDocument();
  });
});
