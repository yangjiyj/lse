import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDemoMode } from './use-demo-mode';

// mock useAuth + api
vi.mock('./auth', () => ({
  useAuth: vi.fn(() => ({
    user: { preferences: { viewMode: 'expert' } },
    refreshUser: vi.fn(async () => {}),
  })),
}));

vi.mock('./api', () => ({
  api: {
    patchMyPreferences: vi.fn(async () => ({ user: { preferences: { viewMode: 'demo' } } })),
  },
}));

import { useAuth } from './auth';
import { api } from './api';

describe('useDemoMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('默认从 user.preferences.viewMode 读取', () => {
    vi.mocked(useAuth).mockReturnValueOnce({
      // @ts-expect-error 测试简化
      user: { preferences: { viewMode: 'demo' } },
      refreshUser: vi.fn(),
    });
    const { result } = renderHook(() => useDemoMode());
    expect(result.current.mode).toBe('demo');
  });

  it('非专家角色未设置 viewMode 时默认 demo', () => {
    vi.mocked(useAuth).mockReturnValueOnce({
      // @ts-expect-error 测试简化
      user: { preferences: {} },
      refreshUser: vi.fn(),
    });
    const { result } = renderHook(() => useDemoMode());
    expect(result.current.mode).toBe('demo');
  });

  it('专家角色未设置 viewMode 时默认 expert', () => {
    vi.mocked(useAuth).mockReturnValueOnce({
      // @ts-expect-error 测试简化
      user: { preferences: {}, roles: ['security_expert'] },
      refreshUser: vi.fn(),
    });
    const { result } = renderHook(() => useDemoMode());
    expect(result.current.mode).toBe('expert');
  });

  it('setMode 调 api.patchMyPreferences 并刷新 user', async () => {
    const refreshUser = vi.fn(async () => {});
    vi.mocked(useAuth).mockReturnValueOnce({
      // @ts-expect-error 测试简化
      user: { preferences: { viewMode: 'expert' } },
      refreshUser,
    });
    const { result } = renderHook(() => useDemoMode());
    await act(async () => {
      await result.current.setMode('demo');
    });
    expect(api.patchMyPreferences).toHaveBeenCalledWith({ viewMode: 'demo' });
    expect(refreshUser).toHaveBeenCalled();
  });
});
