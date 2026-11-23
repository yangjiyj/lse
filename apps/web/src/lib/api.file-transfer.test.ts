import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_TENANTS,
  ApiError,
  TENANT_REQUIRED_EVENT,
  setTenantSelection,
  setToken,
  startBrowserDownload,
  uploadRaw,
} from './api';

/** 最小的 XMLHttpRequest 替身：记下请求，测试里手动给响应。 */
class FakeXhr {
  static last: FakeXhr | null = null;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  status = 0;
  responseText = '';
  body: unknown;
  aborted = false;
  upload: { onprogress: ((e: { loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

describe('startBrowserDownload：浏览器原生下载', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('用普通链接打开接口给的站内地址，不带登录令牌、不经 blob', () => {
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.getAttribute('href') ?? '');
      expect(this.hasAttribute('download')).toBe(true);
    });
    const blob = vi.spyOn(URL, 'createObjectURL');
    startBrowserDownload('/api/tools/download?token=abc');
    expect(clicked).toEqual(['/api/tools/download?token=abc']);
    expect(blob).not.toHaveBeenCalled();
    expect(document.querySelector('a[href*="token"]')).toBeNull();
  });

  it('只接受站内 /api 路径', () => {
    expect(() => startBrowserDownload('https://evil.example/x')).toThrow('下载地址不正确');
  });
});

describe('uploadRaw：原始字节上传', () => {
  beforeEach(() => {
    localStorage.clear();
    setToken('test-token');
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('带登录令牌和查询参数，回报进度，成功时返回 JSON', async () => {
    const file = new Blob(['abc']);
    const progress = vi.fn();
    const done = uploadRaw<{ id: string }>('POST', '/tools/t1/versions', file, {
      query: { version: '1.0.0', filename: 'a.zip' },
      onProgress: progress,
    });
    const xhr = FakeXhr.last!;
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('/api/tools/t1/versions?version=1.0.0&filename=a.zip');
    expect(xhr.headers.Authorization).toBe('Bearer test-token');
    expect(xhr.headers['Content-Type']).toBe('application/octet-stream');
    expect(xhr.body).toBe(file);
    xhr.upload.onprogress?.({ loaded: 1, total: 3 });
    expect(progress).toHaveBeenCalledWith(1, 3);
    xhr.respond(201, { id: 'v1' });
    await expect(done).resolves.toEqual({ id: 'v1' });
  });

  it('取消：中止 XHR，返回「已取消上传」', async () => {
    const ctrl = new AbortController();
    const done = uploadRaw('PUT', '/tools/t1/manuals/m1', new Blob(['x']), {
      signal: ctrl.signal,
    });
    ctrl.abort();
    expect(FakeXhr.last!.aborted).toBe(true);
    await expect(done).rejects.toMatchObject({ code: 'UPLOAD_ABORTED', message: '已取消上传' });
  });

  it('已经取消的信号不再发请求', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    FakeXhr.last = null;
    await expect(
      uploadRaw('POST', '/tools/t1/manuals', new Blob(['x']), { signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: 'UPLOAD_ABORTED' });
    expect(FakeXhr.last).toBeNull();
  });

  it('走统一的错误处理：全部租户视角下 TENANT_REQUIRED 弹「进入租户」', async () => {
    setTenantSelection(ALL_TENANTS);
    const listener = vi.fn();
    window.addEventListener(TENANT_REQUIRED_EVENT, listener);
    try {
      const done = uploadRaw('POST', '/tools/t1/versions', new Blob(['x']));
      FakeXhr.last!.respond(403, { error: { message: '请先进入租户', code: 'TENANT_REQUIRED' } });
      const err = await done.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status: 403, code: 'TENANT_REQUIRED', message: '请先进入租户' });
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(TENANT_REQUIRED_EVENT, listener);
    }
  });

  it('网络中断：返回中文提示', async () => {
    const done = uploadRaw('POST', '/tools/t1/versions', new Blob(['x']));
    FakeXhr.last!.onerror?.();
    await expect(done).rejects.toMatchObject({ message: '上传中断，请检查网络后重试' });
  });
});
