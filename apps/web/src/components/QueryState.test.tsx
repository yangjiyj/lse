import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ApiError } from '@/lib/api';
import { QueryState } from './QueryState';

function renderState(overrides: Partial<Parameters<typeof QueryState>[0]> = {}) {
  const onRetry = vi.fn();
  render(
    <QueryState
      isLoading={false}
      isError={false}
      empty={false}
      emptyTitle="暂无数据"
      emptyDescription="当前范围内没有数据。"
      onRetry={onRetry}
      {...overrides}
    />,
  );
  return onRetry;
}

describe('QueryState', () => {
  it('请求失败时明确提示历史数据未删除，并支持重试', () => {
    const onRetry = renderState({ isError: true, error: new Error('network') });
    expect(screen.getByRole('alert')).toHaveTextContent('数据加载失败');
    expect(screen.getByText(/历史数据没有被删除/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('权限错误与筛选无结果不伪装成普通空数据', () => {
    renderState({
      isError: true,
      error: new ApiError('forbidden', 403),
    });
    expect(screen.getByText('暂无访问权限')).toBeInTheDocument();

    renderState({ isError: false, empty: true, filtered: true });
    expect(screen.getByText('没有匹配结果')).toBeInTheDocument();
    expect(screen.getByText('请调整筛选条件后重试。')).toBeInTheDocument();
  });
});
