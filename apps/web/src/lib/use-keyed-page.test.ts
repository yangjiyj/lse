import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useKeyedPage } from './use-keyed-page';

describe('useKeyedPage', () => {
  it('key 变了回到第 1 页；改回原来的 key 也不回到旧页码', () => {
    const { result, rerender } = renderHook(({ k }) => useKeyedPage(k), {
      initialProps: { k: '' },
    });
    expect(result.current[0]).toBe(1);
    act(() => result.current[1](3));
    expect(result.current[0]).toBe(3);
    rerender({ k: 'x' });
    expect(result.current[0]).toBe(1);
    rerender({ k: '' });
    expect(result.current[0]).toBe(1);
    act(() => result.current[1](2));
    expect(result.current[0]).toBe(2);
  });

  it('key 变化的那次渲染就拿到第 1 页，不会先返回旧页码', () => {
    const seen: number[] = [];
    const { result, rerender } = renderHook(
      ({ k }) => {
        const value = useKeyedPage(k);
        seen.push(value[0]);
        return value;
      },
      { initialProps: { k: 'a' } },
    );
    act(() => result.current[1](5));
    seen.length = 0;
    rerender({ k: 'b' });
    expect(seen.every((p) => p === 1)).toBe(true);
  });

  it('条件不变时保留翻到的页', () => {
    const { result, rerender } = renderHook(({ k }) => useKeyedPage(k), {
      initialProps: { k: 'a' },
    });
    act(() => result.current[1](3));
    rerender({ k: 'a' });
    expect(result.current[0]).toBe(3);
  });
});
