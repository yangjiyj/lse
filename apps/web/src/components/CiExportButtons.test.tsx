import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import { CiGuide } from '@/pages/GatesPage';
import { CiExportButtons } from './CiExportButtons';

const exportCi = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ api: { evalTasks: { exportCi } } }));

describe('CiExportButtons', () => {
  it('三个按钮分别按格式触发导出', async () => {
    exportCi.mockResolvedValue(undefined);
    render(
      <ToastProvider>
        <CiExportButtons taskId="t1" />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'JUnit' }));
    await userEvent.click(screen.getByRole('button', { name: 'SARIF' }));
    await userEvent.click(screen.getByRole('button', { name: 'JSON' }));
    await waitFor(() => expect(exportCi).toHaveBeenCalledTimes(3));
    expect(exportCi.mock.calls.map((c) => c[1])).toEqual(['junit', 'sarif', 'json']);
  });

  it('接入流水线说明包含退出码与脚本要点', () => {
    render(
      <MemoryRouter>
        <CiGuide />
      </MemoryRouter>,
    );
    expect(screen.getByText('接入流水线（CI/CD）')).toBeTruthy();
    expect(screen.getByText(/scripts\/lse-ci\.mjs/)).toBeTruthy();
    expect(screen.getByText(/退出码：0 门禁通过/)).toBeTruthy();
  });
});
