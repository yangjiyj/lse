import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, clearToken, setToken } from './api';

// 下载接口：POST 带登录令牌与接入码，响应按文件下载处理；失败时把后端中文原因抛给界面。
describe('api.fleet.downloadWindowsInstaller', () => {
  const fetchMock = vi.fn();
  let clicks: Array<{ download: string; href: string }>;

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    setToken('tok-123');
    clicks = [];
    URL.createObjectURL = vi.fn(() => 'blob:installer');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push({ download: this.download, href: this.href });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearToken();
    fetchMock.mockReset();
  });

  it('POST 带登录令牌与接入码，用响应头里的文件名触发浏览器下载', async () => {
    fetchMock.mockResolvedValue(
      new Response('MZ-fake-exe', {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="jiandun-probe-setup-windows-amd64.exe"',
        },
      }),
    );
    await api.fleet.downloadWindowsInstaller('jdc_SECRET_CODE_123', 'windows-amd64');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('/api/fleet/install/windows-installer');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok-123');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ code: 'jdc_SECRET_CODE_123', target: 'windows-amd64' });
    expect(clicks).toEqual([
      { download: 'jiandun-probe-setup-windows-amd64.exe', href: 'blob:installer' },
    ]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:installer');
  });

  it('响应头没有文件名时按架构给默认文件名', async () => {
    fetchMock.mockResolvedValue(new Response('MZ', { status: 200 }));
    await api.fleet.downloadWindowsInstaller('jdc_SECRET_CODE_123', 'windows-arm64');
    expect(clicks).toEqual([
      { download: 'jiandun-probe-setup-windows-arm64.exe', href: 'blob:installer' },
    ]);
  });

  it('服务端拒绝时抛出带后端中文原因的 ApiError，且不触发下载', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'FLEET_CODE_UNUSABLE', message: '接入码已过期，请重新创建接入码' },
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await expect(
      api.fleet.downloadWindowsInstaller('jdc_SECRET_CODE_123', 'windows-arm64'),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      code: 'FLEET_CODE_UNUSABLE',
      message: '接入码已过期，请重新创建接入码',
    });
    expect(clicks).toEqual([]);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
