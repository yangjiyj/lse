import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { MOCK_ENDPOINTS } from './__mocks__/data';
import { overviewFixture } from '@/components/fleet/endpoint-overview.test-data';
import { ToastProvider } from '@/components/ui/toast';
import { EndpointDetailPage } from './EndpointDetailPage';
const m = vi.hoisted(() => ({ endpoint: vi.fn(), overview: vi.fn(), checkCatalog: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { fleet: m } }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ hasPermission: () => true }) }));
beforeEach(() => {
  m.endpoint.mockResolvedValue(MOCK_ENDPOINTS[0]);
  m.overview.mockResolvedValue(overviewFixture);
});
function open() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={['/fleet/endpoints/ep1']}>
        <ToastProvider>
          <Routes>
            <Route path="/fleet/endpoints/:id" element={<EndpointDetailPage />} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
it('全页展示终端、概览和终端信息抽屉', async () => {
  open();
  expect(await screen.findByRole('heading', { name: 'demo-host' })).toBeInTheDocument();
  expect(await screen.findByRole('tab', { name: 'Skill 88' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '终端信息' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('终端编号');
});
it('详情页显示硬件卡片和框架分组', async () => {
  m.endpoint.mockResolvedValue({
    ...MOCK_ENDPOINTS[0],
    hardware: {
      collectedAt: '2026-11-21T08:00:00Z',
      os: 'linux',
      osVersion: 'openEuler 22.03 (LTS-SP3)',
      platform: 'openeuler',
      platformVersion: '22.03',
      kernelVersion: '5.10.0-182.0.0.95.oe2203sp3.aarch64',
      arch: 'arm64',
      cpuModel: 'Kunpeng-920',
      cpuCores: 192,
      cpuCountLogical: 192,
      memoryTotalMB: 1546000,
      disks: [],
      accelerators: [
        {
          vendor: 'huawei',
          model: '910B3',
          memoryMB: 65536,
          driverVersion: '24.1.rc2.3',
          index: 0,
          busId: '0000:c1:00.0',
          source: 'npu-smi',
        },
      ],
      aiComponents: [
        {
          id: 'mindspore',
          name: '昇思 MindSpore',
          category: 'training',
          version: '2.3.0',
          source: 'python_package',
          env: 'conda',
        },
      ],
    },
  });
  open();
  const card = await screen.findByRole('region', { name: '硬件' });
  expect(within(card).getByRole('table', { name: '算力卡' })).toHaveTextContent('华为昇腾');
  expect(screen.getByRole('table', { name: '训练框架' })).toHaveTextContent('昇思 MindSpore');
});
it('旧探针没有硬件字段时详情页照常显示，算力卡为「—」', async () => {
  open();
  const card = await screen.findByRole('region', { name: '硬件' });
  expect(within(card).getByTestId('accelerators')).toHaveTextContent(/^—$/);
});
it('吊销终端保留说明并禁用一键检测', async () => {
  m.endpoint.mockResolvedValue({ ...MOCK_ENDPOINTS[0], status: 'REVOKED' });
  open();
  expect(await screen.findByTestId('revoked-note')).toHaveTextContent('无法发起检测或真机测评');
  expect(screen.getByRole('button', { name: '一键检测' })).toBeDisabled();
});
