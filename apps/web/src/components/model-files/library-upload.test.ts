import { describe, expect, it, vi } from 'vitest';
import { chunkEnd, retryDelay, uploadInChunks } from './library-upload';

function transport(offset = 0) {
  let bytes = offset;
  return {
    state: vi.fn(async () => ({ status: 'UPLOADING', bytes, expectedBytes: 10 })),
    chunk: vi.fn(async (_id: string, start: number, part: Blob) => {
      expect(start).toBe(bytes);
      bytes += part.size;
      return { bytes };
    }),
    complete: vi.fn(async () => ({ status: 'READY', bytes })),
  };
}

describe('模型文件分块续传', () => {
  it('分块不超出文件末尾，重试逐步退避并封顶', () => {
    expect(chunkEnd(8, 10, 4)).toBe(10);
    expect([0, 1, 2, 10].map(retryDelay)).toEqual([1000, 2000, 4000, 30000]);
  });

  it('从服务器已接收的位置继续，只发送剩余分块再完成', async () => {
    const api = transport(4);
    const progress = vi.fn();
    await uploadInChunks({
      id: 'u1',
      file: new Blob(['0123456789']),
      chunkSize: 4,
      api,
      onProgress: progress,
    });
    expect(api.chunk.mock.calls.map((call) => [call[1], call[2].size])).toEqual([
      [4, 4],
      [8, 2],
    ]);
    expect(api.complete).toHaveBeenCalledWith('u1', undefined);
    expect(progress).toHaveBeenLastCalledWith(10);
  });

  it('失败后重新查询服务器进度，避免重复发送已经收到的分块', async () => {
    const api = transport();
    const realChunk = api.chunk;
    let failed = false;
    api.chunk = vi.fn(async (...args: Parameters<typeof realChunk>) => {
      const result = await realChunk(...args);
      if (!failed) {
        failed = true;
        throw new Error('网络中断');
      }
      return result;
    });
    const wait = vi.fn(async () => undefined);
    await uploadInChunks({ id: 'u1', file: new Blob(['0123456789']), chunkSize: 4, api, wait });
    expect(api.chunk.mock.calls.map((call) => call[1])).toEqual([0, 4, 8]);
    expect(wait).toHaveBeenCalledWith(1000, undefined);
  });

  it('暂停后不继续发送，也不结束会话', async () => {
    const api = transport();
    const controller = new AbortController();
    await expect(
      uploadInChunks({
        id: 'u1',
        file: new Blob(['0123456789']),
        chunkSize: 4,
        api,
        signal: controller.signal,
        onProgress: (bytes) => {
          if (bytes === 4) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(api.chunk).toHaveBeenCalledTimes(1);
    expect(api.complete).not.toHaveBeenCalled();
  });

  it('核对完成期间取消，不会把晚到的完成响应当作上传成功', async () => {
    const api = transport(10);
    const controller = new AbortController();
    api.complete.mockImplementationOnce(async () => {
      controller.abort();
      return { status: 'READY', bytes: 10 };
    });
    await expect(
      uploadInChunks({
        id: 'u1',
        file: new Blob(['0123456789']),
        chunkSize: 4,
        api,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(api.complete).toHaveBeenCalledWith('u1', controller.signal);
  });

  it('区分发送进度与服务器确认进度，并在文件核对前通知界面', async () => {
    const api = transport(4);
    const confirmed = vi.fn();
    const completing = vi.fn();
    await uploadInChunks({
      id: 'u1',
      file: new Blob(['0123456789']),
      chunkSize: 4,
      api,
      onConfirmed: confirmed,
      onCompleting: completing,
    });
    expect(confirmed.mock.calls.map(([bytes]) => bytes)).toEqual([4, 8, 10]);
    expect(completing).toHaveBeenCalledOnce();
  });

  it('磁盘不足等明确拒绝不自动重试，服务器偏移越界也拒绝', async () => {
    const api = transport();
    api.chunk.mockRejectedValue(Object.assign(new Error('磁盘空间不足'), { status: 413 }));
    await expect(
      uploadInChunks({ id: 'u1', file: new Blob(['0123456789']), chunkSize: 4, api }),
    ).rejects.toThrow('磁盘空间不足');
    expect(api.chunk).toHaveBeenCalledTimes(1);
    const invalid = transport(11);
    await expect(
      uploadInChunks({ id: 'u1', file: new Blob(['0123456789']), chunkSize: 4, api: invalid }),
    ).rejects.toThrow('上传进度');
  });
});
