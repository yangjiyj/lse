import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PASSWORD_CHANGE_REQUIRED_EVENT, api, setToken } from './api';

function fakeResponse(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => text,
  } as unknown as Response;
}

describe('须改密时的 API 客户端行为', () => {
  beforeEach(() => {
    localStorage.clear();
    setToken('test-token');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('403 PASSWORD_CHANGE_REQUIRED 派发事件，交给登录态刷新后跳改密页', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        fakeResponse(403, {
          error: { code: 'PASSWORD_CHANGE_REQUIRED', message: '首次登录须先修改密码' },
        }),
      ),
    );
    const onRequired = vi.fn();
    window.addEventListener(PASSWORD_CHANGE_REQUIRED_EVENT, onRequired);
    await expect(api.tenants.list()).rejects.toThrow('首次登录须先修改密码');
    expect(onRequired).toHaveBeenCalledTimes(1);
    window.removeEventListener(PASSWORD_CHANGE_REQUIRED_EVENT, onRequired);
  });

  it('其他 403 不派发', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          fakeResponse(403, { error: { code: 'FORBIDDEN', message: '没有权限' } }),
        ),
    );
    const onRequired = vi.fn();
    window.addEventListener(PASSWORD_CHANGE_REQUIRED_EVENT, onRequired);
    await expect(api.tenants.list()).rejects.toThrow('没有权限');
    expect(onRequired).not.toHaveBeenCalled();
    window.removeEventListener(PASSWORD_CHANGE_REQUIRED_EVENT, onRequired);
  });
});
