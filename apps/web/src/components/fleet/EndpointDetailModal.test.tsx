import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { MOCK_ENDPOINTS } from '@/pages/fleet/__mocks__/data';
import { EndpointDetailModal } from './EndpointDetailModal';
vi.mock('@/lib/api', () => ({
  api: {
    fleet: {
      endpoint: async () => MOCK_ENDPOINTS[0],
      checkCatalog: async () => undefined,
      posture: async () => undefined,
    },
  },
}));
it('快速预览只留基础摘要，完整清单进入详情页', () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <EndpointDetailModal
          endpoint={MOCK_ENDPOINTS[0]!}
          activeJob={null}
          canManage={true}
          onClose={() => {}}
          onRequestJob={() => {}}
          onRevoke={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(screen.getByRole('link', { name: '打开完整详情' })).toHaveAttribute(
    'href',
    '/fleet/endpoints/ep1',
  );
  expect(screen.queryByText('最近任务')).not.toBeInTheDocument();
  expect(screen.queryByText('风险摘要')).not.toBeInTheDocument();
});
