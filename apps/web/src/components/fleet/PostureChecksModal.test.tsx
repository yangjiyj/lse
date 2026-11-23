import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import { CHECK_CATALOG } from './check-catalog.test-data';
import { MOCK_ENDPOINTS } from '@/pages/fleet/__mocks__/data';
import { PostureChecksModal } from './PostureChecksModal';

const m = vi.hoisted(() => ({ catalog: vi.fn(), posture: vi.fn(), live: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { fleet: { checkCatalog: m.catalog, postureEval: m.posture, requestEvalJob: m.live } } }));

it('runs selected configuration checks without exposing or starting agent evaluation', async () => {
  m.catalog.mockResolvedValue(CHECK_CATALOG);
  m.posture.mockResolvedValue({ taskId: 'posture-task' });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><ToastProvider><PostureChecksModal endpoint={MOCK_ENDPOINTS[0]!} onClose={() => {}} /></ToastProvider></MemoryRouter>
  </QueryClientProvider>);
  await waitFor(() => expect(screen.getByRole('button', { name: '开始检测' })).toBeEnabled());
  expect(screen.queryByRole('checkbox', { name: '启用真机测评' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '开始检测' }));
  await waitFor(() => expect(m.posture).toHaveBeenCalledWith(MOCK_ENDPOINTS[0]!.id, { items: CHECK_CATALOG.posture.map((item) => item.id) }));
  expect(m.live).not.toHaveBeenCalled();
  expect(await screen.findByRole('link', { name: '查看检测结果' })).toHaveAttribute('href', '/eval-tasks/posture-task');
});
