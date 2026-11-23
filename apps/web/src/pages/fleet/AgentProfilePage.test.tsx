import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { AgentProfilePage } from './AgentProfilePage';

const m = vi.hoisted(() => ({ agents: vi.fn(), jobs: vi.fn(), summary: vi.fn(), samples: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { fleet: { agents: m.agents, evalJobs: m.jobs },
  evalTasks: { endpointSummary: m.summary }, agentSamples: { list: m.samples } } }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ hasPermission: () => true }) }));

it('显示当前智能体、历史任务及各样本的真实结论', async () => {
  m.agents.mockResolvedValue({ items: [{ endpointId: 'ep1', endpointName: 'demo-host', agentKey: 'claude-code',
    agentName: 'Claude Code', version: '1.0', status: 'ready', scope: 'all', latest: { conclusion: '发现风险' } }] });
  m.jobs.mockResolvedValue({ items: [{ id: 'job1', evalTaskId: 'task1', product: 'claude-code', status: 'COMPLETED',
    statusLabel: '已完成', createdAt: '2026-11-01T10:00:00Z', scenarioCount: 2 }], total: 1 });
  m.samples.mockResolvedValue({ items: [{ id: 'sample-a', title: '凭据备份' }] });
  m.summary.mockResolvedValue({ verdictLine: '发现风险', liveScenarios: [{ scenarioId: 'run1', outcome: 'allowed',
    runtime: { sample_id: 'sample-a', outcome: 'complied' } }] });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={['/fleet/agents/ep1/claude-code']}><Routes>
      <Route path="/fleet/agents/:endpointId/:agentKey" element={<AgentProfilePage />} />
    </Routes></MemoryRouter>
  </QueryClientProvider>);
  expect(await screen.findByRole('heading', { name: 'Claude Code' })).toBeInTheDocument();
  expect(screen.getByText('demo-host')).toBeInTheDocument();
  const row = (await screen.findByText('凭据备份')).closest('tr')!;
  expect(within(row).getByText('照做')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '发起测评' })).toHaveAttribute('href', '/agent-evals/new?endpoint=ep1&agent=claude-code');
  expect(m.jobs).toHaveBeenCalledWith(expect.objectContaining({ endpointId: 'ep1', product: 'claude-code' }));
});
