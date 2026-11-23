/** 上传按服务器确认的字节数推进；中断后重新查询，避免重复追加数据。 */
export function chunkEnd(offset: number, total: number, chunkSize: number) {
  return Math.min(total, offset + chunkSize);
}

export function retryDelay(attempt: number) {
  return Math.min(30_000, 1000 * 2 ** attempt);
}

export interface UploadTransport {
  state(id: string): Promise<{ status: string; bytes: number; expectedBytes: number | null }>;
  chunk(
    id: string,
    offset: number,
    data: Blob,
    signal?: AbortSignal,
    onProgress?: (bytes: number) => void,
  ): Promise<{ bytes: number }>;
  complete(id: string, signal?: AbortSignal): Promise<unknown>;
}

function aborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('上传已暂停', 'AbortError');
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    aborted(signal);
    const stop = () => {
      clearTimeout(timer);
      reject(new DOMException('上传已暂停', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

export async function uploadInChunks({
  id,
  file,
  chunkSize,
  api,
  signal,
  onProgress,
  onConfirmed,
  onCompleting,
  onRetry,
  wait = waitForRetry,
}: {
  id: string;
  file: Blob;
  chunkSize: number;
  api: UploadTransport;
  signal?: AbortSignal;
  onProgress?: (bytes: number) => void;
  onConfirmed?: (bytes: number) => void;
  onCompleting?: () => void;
  onRetry?: (attempt: number) => void;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}) {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0)
    throw new Error('上传配置有误，请刷新后重试');
  let failures = 0;
  while (true) {
    aborted(signal);
    try {
      const state = await api.state(id);
      aborted(signal);
      if (!Number.isSafeInteger(state.bytes) || state.bytes < 0 || state.bytes > file.size)
        throw Object.assign(new Error('服务器上传进度与所选文件不一致，请重新选择原文件'), {
          status: 400,
        });
      if (state.expectedBytes !== null && state.expectedBytes !== file.size)
        throw Object.assign(new Error('请选择之前上传的同一个文件'), { status: 400 });
      if (state.status === 'READY') {
        onConfirmed?.(file.size);
        onProgress?.(file.size);
        return;
      }
      if (state.status !== 'UPLOADING')
        throw Object.assign(new Error('该上传已取消，请重新上传'), { status: 400 });
      let offset = state.bytes;
      onConfirmed?.(offset);
      onProgress?.(offset);
      while (offset < file.size) {
        aborted(signal);
        const end = chunkEnd(offset, file.size, chunkSize);
        const start = offset;
        const received = await api.chunk(id, start, file.slice(start, end), signal, (bytes) =>
          onProgress?.(start + bytes),
        );
        if (received.bytes !== end) throw new Error('服务器上传进度发生变化，正在重新确认');
        offset = received.bytes;
        failures = 0;
        aborted(signal);
        onConfirmed?.(offset);
        onProgress?.(offset);
      }
      aborted(signal);
      onCompleting?.();
      await api.complete(id, signal);
      aborted(signal);
      return;
    } catch (error) {
      aborted(signal);
      const status = (error as { status?: number }).status;
      if (
        status &&
        status >= 400 &&
        status < 500 &&
        status !== 409 &&
        status !== 408 &&
        status !== 429
      )
        throw error;
      if (failures >= 6) throw error;
      onRetry?.(failures + 1);
      await wait(retryDelay(failures++), signal);
    }
  }
}
