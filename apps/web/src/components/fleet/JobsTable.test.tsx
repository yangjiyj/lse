import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it } from 'vitest';
import { JobsTable } from './JobsTable';
import { MOCK_JOBS } from '@/pages/fleet/__mocks__/data';
afterEach(cleanup);
it('失败和超期任务都显示中文处理办法', () => {
  const jobs = [
    {
      ...MOCK_JOBS[0]!,
      id: 'failed-job',
      status: 'FAILED' as const,
      product: 'codex' as const,
      errorCode: 'product_not_registered',
    },
    { ...MOCK_JOBS[0]!, id: 'expired-job', status: 'EXPIRED' as const, errorCode: 'expired' },
  ];
  render(
    <MemoryRouter>
      <JobsTable
        jobs={jobs}
        canManage={false}
        onApprove={() => {}}
        onReject={() => {}}
        onCancel={() => {}}
        onForceClose={() => {}}
      />
    </MemoryRouter>,
  );
  expect(screen.getByText(/没有登记 Codex 的测评/)).toBeTruthy();
  expect(screen.getByText(/未在截止时间前完成任务.*请确认终端在线/)).toBeTruthy();
  expect(screen.queryByText(/product_not_registered/)).toBeNull();
});
