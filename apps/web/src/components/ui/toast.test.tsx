import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ToastProvider, useToast } from './toast';
function Notify() {
  const toast = useToast();
  return <button onClick={() => toast.success('测评已发起')}>发起测评</button>;
}
afterEach(() => vi.useRealTimers());
it('离开页面时清理提示定时器，避免销毁环境后继续更新页面', () => {
  vi.useFakeTimers();
  const view = render(
    <ToastProvider>
      <Notify />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: '发起测评' }));
  expect(screen.getByText('测评已发起')).toBeInTheDocument();
  expect(vi.getTimerCount()).toBe(1);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
it('手动关闭提示时清理对应定时器', () => {
  vi.useFakeTimers();
  render(
    <ToastProvider>
      <Notify />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: '发起测评' }));
  fireEvent.click(screen.getByRole('button', { name: '关闭提示' }));
  expect(vi.getTimerCount()).toBe(0);
});
