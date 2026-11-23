import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_TENANTS,
  TENANT_REQUIRED_EVENT,
  api,
  getTenantSelection,
  setTenantSelection,
  setToken,
} from './api';

/** 不依赖 jsdom 的 Response 全局，手搓最小响应对象。 */
function fakeResponse(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => text,
  } as unknown as Response;
}

describe('全部租户视角的 API 客户端行为', () => {
  beforeEach(() => {
    localStorage.clear();
    setToken('test-token');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("setTenantSelection('all') 会写进 localStorage 并带上 x-lse-tenant: all", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, { items: [] }));
    vi.stubGlobal('fetch', fetchMock);
    setTenantSelection(ALL_TENANTS);
    expect(getTenantSelection()).toBe('all');

    await api.tenants.list();
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-token');
    expect(headers['x-lse-tenant']).toBe('all');
  });

  it('setTenantSelection(null) 回到本属租户，不再带租户头', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, { items: [] }));
    vi.stubGlobal('fetch', fetchMock);
    setTenantSelection('all');
    setTenantSelection(null);
    expect(getTenantSelection()).toBeNull();

    await api.tenants.list();
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-lse-tenant']).toBeUndefined();
  });

  it('全部租户视角下的写请求不带租户头，落回本属租户', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    setTenantSelection(ALL_TENANTS);

    await api.tenants.transfer({
      kind: 'model-target',
      targetId: 't-b',
      ids: ['mt-1'],
    } as never);

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-token');
    // 关键：写请求不带 all，否则服务端会以 TENANT_REQUIRED 拒绝，前端只能弹「建到哪个租户」。
    expect(headers['x-lse-tenant']).toBeUndefined();
  });

  it('409 TENANT_REQUIRED 在全部租户视角下派发弹框事件，而不是普通报错', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse(409, {
        error: { code: 'TENANT_REQUIRED', message: '请先进入具体租户再操作' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    setTenantSelection(ALL_TENANTS);
    const onRequired = vi.fn();
    window.addEventListener(TENANT_REQUIRED_EVENT, onRequired);

    await expect(api.tenants.list()).rejects.toThrow('请先进入具体租户再操作');
    expect(onRequired).toHaveBeenCalledTimes(1);
    window.removeEventListener(TENANT_REQUIRED_EVENT, onRequired);
  });

  it('具体租户视角下同样的 409 不派发弹框事件', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse(409, {
        error: { code: 'TENANT_REQUIRED', message: '请先进入具体租户再操作' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    setTenantSelection('t-a');
    const onRequired = vi.fn();
    window.addEventListener(TENANT_REQUIRED_EVENT, onRequired);

    await expect(api.tenants.list()).rejects.toThrow('请先进入具体租户再操作');
    expect(onRequired).not.toHaveBeenCalled();
    window.removeEventListener(TENANT_REQUIRED_EVENT, onRequired);
  });
});
