import { useCallback, useState } from 'react';

/**
 * 页码跟着筛选条件（key）走：key 一变就回到第 1 页。
 * 在渲染时同步重置，不在 effect 里重置：换筛选时不会先用旧页码多发一次请求，
 * 筛选改回原来的值（比如清空搜索）也不会回到旧页码。
 */
export function useKeyedPage(key: string): [number, (page: number) => void] {
  const [state, setState] = useState({ key, page: 1 });
  if (state.key !== key) setState({ key, page: 1 });
  const setPage = useCallback((page: number) => setState({ key, page }), [key]);
  return [state.key === key ? state.page : 1, setPage];
}
