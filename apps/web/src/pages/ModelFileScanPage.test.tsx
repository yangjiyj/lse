import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { ToastProvider } from '@/components/ui/toast';
import { ModelFileScanPage } from './ModelFileScanPage';
import { TargetAibomSection } from '@/components/model-files/TargetAibomSection';
import { modelFilesApi } from '@/lib/api';

vi.mock('@/lib/auth', () => ({ useAuth: () => ({ hasPermission: () => true }) }));

const { scan } = vi.hoisted(() => ({
  scan: {
    id: 's1',
    source: 'DIRECTORY',
    path: '/data/models',
    targetId: null,
    target: null,
    status: 'COMPLETED',
    error: null,
    fileCount: 1,
    totalBytes: 2048,
    skippedCount: 0,
    highCount: 2,
    mediumCount: 0,
    lowCount: 0,
    hasAibom: true,
    createdBy: null,
    createdAt: '2026-09-29T00:00:00.000Z',
    progressFiles: 1,
    progressBytes: 2048,
    plannedFiles: 1,
    plannedBytes: 2048,
    truncatedCount: 0,
    truncatedReason: null,
    files: [{ path: 'evil.pkl', format: 'pickle', bytes: 2048, sha256: 'a'.repeat(64), meta: {} }],
  },
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    modelTargets: {
      list: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 }),
    },
  },
  modelFilesApi: {
    library: vi.fn().mockResolvedValue({
      items: [
        {
          id: 'u1',
          fileName: '模型.gguf',
          bytes: 2048,
          expectedBytes: 2048,
          status: 'READY',
          sha256: 'abc',
          createdBy: { id: 'a1', displayName: '管理员甲' },
          createdAt: '2026-10-23T00:00:00Z',
          latestScan: { id: 's1', status: 'COMPLETED', verdict: '发现风险' },
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
      diskFreeBytes: 100 * 1024 ** 3,
      libraryBytes: 2048,
    }),
    deleteLibrary: vi.fn().mockResolvedValue({ deleted: true }),
    scanLibrary: vi.fn().mockResolvedValue({ id: 's1', status: 'PENDING' }),
    createLibraryUpload: vi.fn().mockResolvedValue({ uploadId: 'u2', chunkSize: 4 }),
    libraryUpload: vi.fn().mockResolvedValue({ status: 'UPLOADING', bytes: 0, expectedBytes: 4 }),
    uploadLibraryChunk: vi.fn().mockResolvedValue({ bytes: 4 }),
    completeLibraryUpload: vi.fn().mockResolvedValue({ uploadId: 'u2', status: 'READY', bytes: 4 }),
    config: vi.fn().mockResolvedValue({
      roots: ['/data/models'],
      pickleMaxBytes: 512 * 1024 * 1024,
      totalMaxBytes: 1024 ** 4,
      maxFiles: 10000,
      uploadMaxBytes: 2 * 1024 ** 3,
      envRoots: ['/models'],
      hostDir: null,
      ignoredRoots: [],
      limitBounds: {
        pickleMaxBytes: { min: 1024, max: 8 * 1024 ** 3 },
        totalMaxBytes: { min: 1024, max: 16 * 1024 ** 4 },
        maxFiles: { min: 1, max: 100000 },
      },
      rootDetails: [
        {
          path: '/models',
          hostPath: null,
          source: 'deploy',
          exists: true,
          readable: true,
          problem: null,
        },
        {
          path: '/data/models',
          hostPath: null,
          source: 'admin',
          exists: true,
          readable: true,
          problem: null,
        },
      ],
    }),
    browse: vi.fn().mockResolvedValue({
      path: '/models',
      hostPath: null,
      directories: ['llama'],
      directoryTotal: 1,
      modelFiles: [],
      modelFileTotal: 0,
      fileCount: 1,
      otherFileCount: 1,
      truncated: false,
      scanLimited: false,
      limit: 500,
    }),
    updateConfig: vi.fn(),
    scanDirectory: vi.fn(),
    list: vi.fn().mockResolvedValue({ items: [scan], total: 1, page: 1, pageSize: 10 }),
    get: vi.fn().mockResolvedValue(scan),
    scriptRisks: vi.fn().mockResolvedValue({ groups: [] }),
    rules: vi.fn().mockResolvedValue({ total: 0, items: [] }),
    findings: vi.fn().mockResolvedValue({
      items: [
        {
          id: 'f1',
          scanId: 's1',
          filePath: 'evil.pkl',
          format: 'pickle',
          severity: 'HIGH',
          ruleId: 'PICKLE_DANGEROUS_GLOBAL',
          title: 'Pickle 引用危险全局对象',
          evidence: 'STACK_GLOBAL os.system',
          riskCategory: '组件安全',
          createdAt: '',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    }),
    exportAibom: vi.fn(),
    targetAibom: vi.fn().mockResolvedValue(null),
    targetLatest: vi.fn().mockResolvedValue(null),
    cancel: vi.fn().mockResolvedValue({}),
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

describe('ModelFileScanPage', () => {
  it('删除必须二次确认，说明删除范围与历史结果保留', async () => {
    wrap(<ModelFileScanPage />);
    fireEvent.click(await screen.findByRole('button', { name: '删除 模型.gguf' }));
    const dialog = await screen.findByRole('dialog', { name: '删除模型文件' });
    expect(dialog).toHaveTextContent(
      '只删除您上传的这个文件，服务器模型目录里的文件不受影响；历史扫描结果会保留',
    );
    expect(dialog).toHaveTextContent('不能撤销');
    expect(modelFilesApi.deleteLibrary).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(modelFilesApi.deleteLibrary).toHaveBeenCalledWith('u1'));
  });

  it('选中文件立即分块上传，完成后保留在文件库中', async () => {
    wrap(<ModelFileScanPage />);
    fireEvent.change(await screen.findByLabelText('模型文件'), {
      target: { files: [new File(['1234'], '新模型.gguf')] },
    });
    await waitFor(() =>
      expect(modelFilesApi.completeLibraryUpload).toHaveBeenCalledWith(
        'u2',
        expect.any(AbortSignal),
      ),
    );
    expect(modelFilesApi.createLibraryUpload).toHaveBeenCalledWith({
      fileName: '新模型.gguf',
      totalBytes: 4,
    });
    expect(modelFilesApi.uploadLibraryChunk).toHaveBeenCalledWith(
      'u2',
      0,
      expect.any(Blob),
      expect.any(AbortSignal),
      expect.any(Function),
    );
  });

  it('重新进入页面后可从未完成列表选择原文件续传', async () => {
    vi.mocked(modelFilesApi.library).mockResolvedValueOnce({
      items: [
        {
          id: 'u3',
          fileName: '未完成.gguf',
          bytes: 2,
          expectedBytes: 4,
          status: 'UPLOADING',
          sha256: null,
          createdBy: null,
          createdAt: '2026-10-23T00:00:00Z',
          latestScan: null,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
      diskFreeBytes: 100 * 1024 ** 3,
      libraryBytes: 2,
    });
    vi.mocked(modelFilesApi.libraryUpload).mockResolvedValueOnce({
      status: 'UPLOADING',
      bytes: 2,
      expectedBytes: 4,
    });
    wrap(<ModelFileScanPage />);
    fireEvent.change(await screen.findByLabelText('继续上传 未完成.gguf'), {
      target: { files: [new File(['1234'], '未完成.gguf')] },
    });
    await waitFor(() =>
      expect(modelFilesApi.uploadLibraryChunk).toHaveBeenCalledWith(
        'u3',
        2,
        expect.any(Blob),
        expect.any(AbortSignal),
        expect.any(Function),
      ),
    );
    await waitFor(() =>
      expect(modelFilesApi.completeLibraryUpload).toHaveBeenCalledWith(
        'u3',
        expect.any(AbortSignal),
      ),
    );
  });

  it('库文件可发起扫描，最近扫描也可直接查看', async () => {
    wrap(<ModelFileScanPage />);
    fireEvent.click(await screen.findByRole('button', { name: '扫描 模型.gguf' }));
    await waitFor(() =>
      expect(modelFilesApi.scanLibrary).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ targetId: null }),
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: '查看最近扫描' }));
    expect(await screen.findByText('STACK_GLOBAL os.system')).toBeInTheDocument();
  });

  it('暂停后回查服务器进度，不把未确认的分块算作已传内容', async () => {
    vi.mocked(modelFilesApi.libraryUpload)
      .mockResolvedValueOnce({ status: 'UPLOADING', bytes: 0, expectedBytes: 4 })
      .mockResolvedValueOnce({ status: 'UPLOADING', bytes: 0, expectedBytes: 4 });
    vi.mocked(modelFilesApi.uploadLibraryChunk).mockImplementationOnce(
      async (_id, _offset, _data, signal, onProgress) => {
        onProgress?.(3);
        await new Promise<void>((_resolve, reject) =>
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('已暂停', 'AbortError')),
            { once: true },
          ),
        );
        return { bytes: 4 };
      },
    );
    wrap(<ModelFileScanPage />);
    fireEvent.change(await screen.findByLabelText('模型文件'), {
      target: { files: [new File(['1234'], '暂停模型.gguf')] },
    });
    await waitFor(() =>
      expect(screen.getByRole('progressbar', { name: '上传进度' })).toHaveAttribute('value', '3'),
    );
    const calls = vi.mocked(modelFilesApi.libraryUpload).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: '暂停上传' }));
    await screen.findByRole('button', { name: '继续上传' });
    expect(vi.mocked(modelFilesApi.libraryUpload).mock.calls.length).toBeGreaterThan(calls);
    expect(screen.getByRole('progressbar', { name: '上传进度' })).toHaveAttribute('value', '0');
  });

  it('核对阶段说明在后台处理且不展示无效暂停，取消后不被晚到完成覆盖', async () => {
    let finish!: () => void;
    vi.mocked(modelFilesApi.completeLibraryUpload).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { uploadId: 'u2', status: 'READY', bytes: 4 };
    });
    wrap(<ModelFileScanPage />);
    fireEvent.change(await screen.findByLabelText('模型文件'), {
      target: { files: [new File(['1234'], '取消模型.gguf')] },
    });
    expect(await screen.findByText(/正在后台核对/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '暂停上传' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消上传' }));
    const dialog = await screen.findByRole('dialog', { name: '删除模型文件' });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }));
    await screen.findByText('已取消上传，服务器上的未完成文件已删除');
    finish();
    await waitFor(() => expect(screen.getByLabelText('模型文件')).not.toBeDisabled());
    expect(screen.getByText('已取消上传，服务器上的未完成文件已删除')).toBeInTheDocument();
    expect(
      screen.queryByText('上传完成，文件已保存在服务器上，可随时扫描或删除'),
    ).not.toBeInTheDocument();
  });

  it('明确说明重新进入后需要在列表中选择原文件续传', async () => {
    wrap(<ModelFileScanPage />);
    expect(await screen.findByText(/在下方未完成文件旁选择原文件继续/)).toBeInTheDocument();
  });

  it('创建上传失败时显示原因，不误认为已经取消', async () => {
    vi.mocked(modelFilesApi.createLibraryUpload).mockRejectedValueOnce(
      new Error('服务器磁盘剩余不足，无法上传'),
    );
    wrap(<ModelFileScanPage />);
    fireEvent.change(await screen.findByLabelText('模型文件'), {
      target: { files: [new File(['1234'], '磁盘不足模型.gguf')] },
    });
    expect(await screen.findByText('服务器磁盘剩余不足，无法上传')).toBeInTheDocument();
    expect(screen.getByLabelText('模型文件')).not.toBeDisabled();
  });

  it('默认不限制文件大小，说明由服务器可用空间决定', async () => {
    const config = await modelFilesApi.config();
    vi.mocked(modelFilesApi.config).mockResolvedValueOnce({ ...config, uploadMaxBytes: 0 });
    wrap(<ModelFileScanPage />);
    expect(await screen.findByText('文件大小由服务器可用空间决定')).toBeInTheDocument();
    expect(screen.queryByText(/管理员设置的单个文件大小/)).not.toBeInTheDocument();
    expect(screen.queryByText(/文件 SHA-256/)).not.toBeInTheDocument();
    expect(screen.getByText(/文件指纹、格式/)).toBeInTheDocument();
  });

  it('配置了可选硬上限时展示管理员设置说明', async () => {
    wrap(<ModelFileScanPage />);
    expect(
      await screen.findByText('管理员设置的单个文件大小为 2 GiB；如需调整请联系管理员'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/更大的模型请放/)).not.toBeInTheDocument();
  });

  it('页面自身不再渲染面包屑（由 AppShell 统一渲染）', async () => {
    wrap(<ModelFileScanPage />);
    expect(await screen.findByRole('heading', { name: '模型文件扫描' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: '面包屑' })).not.toBeInTheDocument();
    expect(screen.queryByText('专项核验 / 模型文件扫描')).not.toBeInTheDocument();
  });

  it('展示文件库与磁盘剩余、扫描记录与明细证据', async () => {
    wrap(<ModelFileScanPage />);
    expect(await screen.findByRole('tab', { name: '模型文件库' })).toBeInTheDocument();
    expect(await screen.findByText('模型.gguf')).toBeInTheDocument();
    expect(screen.getByText('管理员甲')).toBeInTheDocument();
    expect(screen.getByText(/服务器磁盘剩余 100 GiB/)).toBeInTheDocument();
    expect(screen.queryByText(/上传上限|更大的模型请放/)).not.toBeInTheDocument();
    fireEvent.click(await screen.findByText('查看明细'));
    expect(await screen.findByText('STACK_GLOBAL os.system')).toBeInTheDocument();
    expect(screen.getByText('导出 AIBOM（CycloneDX 1.6 JSON）')).toBeInTheDocument();
    expect(screen.queryByText('扫描配置（管理员）')).not.toBeInTheDocument();
  });

  it('目录扫描只能在白名单根下逐级选择子目录', async () => {
    wrap(<ModelFileScanPage />);
    fireEvent.click(await screen.findByRole('tab', { name: '目录扫描' }));
    expect(await screen.findByRole('button', { name: '进入目录 llama' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /\/data\/models/ })).toBeInTheDocument();
  });

  it('评估对象未扫描时提示去模型文件扫描发起', async () => {
    wrap(<TargetAibomSection targetId="t1" />);
    expect(await screen.findByText(/尚未扫描该对象的模型文件/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '模型文件扫描' })).toHaveAttribute(
      'href',
      '/inspect/model-files',
    );
  });

  it('评估对象显示最近一次扫描结论', async () => {
    vi.mocked(modelFilesApi.targetLatest).mockResolvedValueOnce({
      id: 's9',
      status: 'COMPLETED',
      source: 'DIRECTORY',
      path: '/models/x',
      createdAt: '2026-09-29T00:00:00.000Z',
      finishedAt: '2026-09-29T00:01:00.000Z',
      fileCount: 3,
      highCount: 4,
      mediumCount: 1,
      lowCount: 0,
      truncatedCount: 2,
      error: null,
    } as never);
    wrap(<TargetAibomSection targetId="t1" />);
    const box = await screen.findByLabelText('最近一次模型文件扫描');
    expect(box).toHaveTextContent('最近一次扫描：已完成');
    expect(box).toHaveTextContent('高危 4');
    expect(box).toHaveTextContent('部分结果');
  });

  it('运行中的扫描显示进度并可取消', async () => {
    const running = {
      ...scan,
      status: 'RUNNING',
      progressFiles: 1,
      plannedFiles: 4,
      plannedBytes: 8192,
    };
    vi.mocked(modelFilesApi.list).mockResolvedValue({
      items: [running],
      total: 1,
      page: 1,
      pageSize: 10,
    } as never);
    vi.mocked(modelFilesApi.get).mockResolvedValue(running as never);
    wrap(<ModelFileScanPage />);
    expect(await screen.findByText('扫描中')).toBeInTheDocument();
    fireEvent.click(screen.getByText('查看明细'));
    expect(await screen.findByText(/（25%）/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: '取消' })[0]!);
    expect(await screen.findByText('已取消')).toBeInTheDocument();
    expect(modelFilesApi.cancel).toHaveBeenCalledWith('s1');
    vi.mocked(modelFilesApi.list).mockResolvedValue({
      items: [scan],
      total: 1,
      page: 1,
      pageSize: 10,
    } as never);
    vi.mocked(modelFilesApi.get).mockResolvedValue(scan as never);
  });

  it('没有可扫描目录时说明怎么做，不露环境变量名', async () => {
    vi.mocked(modelFilesApi.config).mockResolvedValueOnce({
      roots: [],
      envRoots: [],
      rootDetails: [],
      hostDir: '/opt/lse/models',
      ignoredRoots: [],
      limitBounds: {
        pickleMaxBytes: { min: 1, max: 2 },
        totalMaxBytes: { min: 1, max: 2 },
        maxFiles: { min: 1, max: 2 },
      },
      pickleMaxBytes: 1,
      totalMaxBytes: 1,
      maxFiles: 1,
      uploadMaxBytes: 1,
    } as never);
    wrap(<ModelFileScanPage />);
    fireEvent.click(await screen.findByRole('tab', { name: '目录扫描' }));
    const box = await screen.findByTestId('no-roots');
    expect(box).toHaveTextContent('/opt/lse/models');
    expect(document.body.textContent).not.toMatch(/MODEL_SCAN|环境变量|\.env/);
  });
});

describe('ModelFileScanPage 地址参数', () => {
  it('地址带 ?scan= 时直接打开这次扫描的明细', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/inspect/model-files?scan=s1']}>
            <ModelFileScanPage />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('扫描明细')).toBeInTheDocument();
    await waitFor(() => expect(modelFilesApi.get).toHaveBeenCalledWith('s1'));
  });
});
