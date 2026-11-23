import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useIdleTimeout } from './SessionSecurityGuard';

vi.mock('@/lib/auth', () => ({ useAuth: () => ({}) }));
vi.mock('@/lib/api', () => ({ ApiError: class extends Error {}, api: {} }));

describe('useIdleTimeout 超时登出', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('超过超时登出时间无操作即触发', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    renderHook(() => useIdleTimeout(1, onTimeout));
    vi.advanceTimersByTime(45_000);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('有操作时重新计时', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    renderHook(() => useIdleTimeout(1, onTimeout));
    vi.advanceTimersByTime(45_000);
    window.dispatchEvent(new Event('keydown'));
    vi.advanceTimersByTime(45_000);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('0 表示不限制', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    renderHook(() => useIdleTimeout(0, onTimeout));
    vi.advanceTimersByTime(24 * 3600_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
