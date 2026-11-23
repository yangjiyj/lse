import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOL_MANUAL_MAX_BYTES } from '@lse/shared';
import { ToastProvider } from '@/components/ui/toast';
import { ManualUploadModal, VersionUploadModal } from './UploadModals';

const mocks = vi.hoisted(() => ({
  uploadVersion: vi.fn(),
  uploadManual: vi.fn(),
  replaceManual: vi.fn(),
}));

vi.mock('@/lib/tools', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tools')>()),
  toolsApi: {
    uploadVersion: mocks.uploadVersion,
    uploadManual: mocks.uploadManual,
    replaceManual: mocks.replaceManual,
  },
}));

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

function fileOfSize(name: string, size: number): File {
  const file = new File(['x'], name);
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('UploadModals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('版本文件超过上限：直接提示，不发上传请求', async () => {
    wrap(<VersionUploadModal toolId="t1" maxBytes={1024} onClose={vi.fn()} />);
    await userEvent.upload(
      document.querySelector<HTMLInputElement>('#tool-version-file')!,
      fileOfSize('big.zip', 2048),
    );
    await userEvent.type(screen.getByLabelText(/版本号/), '1.0.0');
    await userEvent.click(screen.getByRole('button', { name: '上传' }));
    expect(screen.getByRole('alert')).toHaveTextContent('文件超过 1 KiB 的上限');
    expect(mocks.uploadVersion).not.toHaveBeenCalled();
  });

  it('手册超过 100 MiB：直接提示，不发上传请求', async () => {
    wrap(<ManualUploadModal toolId="t1" onClose={vi.fn()} />);
    await userEvent.upload(
      document.querySelector<HTMLInputElement>('#tool-manual-file')!,
      fileOfSize('guide.pdf', TOOL_MANUAL_MAX_BYTES + 1),
    );
    await userEvent.click(screen.getByRole('button', { name: '上传' }));
    expect(screen.getByRole('alert')).toHaveTextContent('文件超过 100 MiB 的上限');
    expect(mocks.uploadManual).not.toHaveBeenCalled();
  });

  it('上传中点「取消」：中止上传并关闭弹窗', async () => {
    let signal: AbortSignal | undefined;
    mocks.uploadVersion.mockImplementation(
      (_id: string, _file: File, _meta: unknown, opts: { signal?: AbortSignal }) => {
        signal = opts.signal;
        return new Promise((_resolve, reject) =>
          opts.signal?.addEventListener('abort', () => reject(new Error('已取消上传'))),
        );
      },
    );
    const onClose = vi.fn();
    wrap(<VersionUploadModal toolId="t1" maxBytes={1024} onClose={onClose} />);
    await userEvent.upload(
      document.querySelector<HTMLInputElement>('#tool-version-file')!,
      fileOfSize('ok.zip', 10),
    );
    await userEvent.type(screen.getByLabelText(/版本号/), '1.0.0');
    await userEvent.click(screen.getByRole('button', { name: '上传' }));
    expect(mocks.uploadVersion).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
    const cancel = screen.getByRole('button', { name: '取消' });
    expect(cancel).toBeEnabled();
    await userEvent.click(cancel);
    expect(signal?.aborted).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });

  it('替换手册上传中也能取消', async () => {
    let signal: AbortSignal | undefined;
    mocks.replaceManual.mockImplementation(
      (_id: string, _m: string, _f: File, _t: string, opts: { signal?: AbortSignal }) => {
        signal = opts.signal;
        return new Promise(() => undefined);
      },
    );
    const onClose = vi.fn();
    wrap(
      <ManualUploadModal
        toolId="t1"
        manual={{
          id: 'm1',
          title: '指南',
          filename: 'guide.md',
          size: 1,
          sha256: 'a'.repeat(64),
          mime: 'text/markdown',
          createdAt: '',
          updatedAt: '',
          createdBy: null,
          downloadUrl: '',
        }}
        onClose={onClose}
      />,
    );
    await userEvent.upload(
      document.querySelector<HTMLInputElement>('#tool-manual-file')!,
      fileOfSize('guide.md', 10),
    );
    await userEvent.click(screen.getByRole('button', { name: '替换' }));
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(signal?.aborted).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });
});
