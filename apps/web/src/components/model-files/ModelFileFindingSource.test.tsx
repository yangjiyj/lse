import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import { ModelFileFindingSource } from './ModelFileFindingSource';

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', isBuiltin: false }, hasPermission: () => true }),
}));

const { row, api } = vi.hoisted(() => {
  const base = {
    scanId: 's1',
    format: 'pickle',
    severity: 'HIGH',
    ruleId: 'PICKLE_DANGEROUS_GLOBAL',
    title: 'pickle 引用危险可调用对象',
    evidence: 'os.system',
    riskCategory: '组件安全',
    createdAt: '2026-09-29T00:00:00.000Z',
    reviewStatus: 'UNREVIEWED',
    reviewReason: null,
    remediationStatus: 'OPEN',
    remediationOwner: null,
    remediationAction: null,
    remediationDueAt: null,
    remediationRecord: null,
    remediationClosureEvidence: null,
    remediationRetestScanId: null,
    remediationClosedAt: null,
  };
  const scan = (createdById: string) => ({
    id: 's1',
    source: 'DIRECTORY',
    path: '/models/a',
    createdAt: '2026-09-29T00:00:00.000Z',
    createdById,
    target: null,
  });
  const row = [
    { ...base, id: 'mine', filePath: 'mine.bin', scan: scan('u1') },
    { ...base, id: 'theirs', filePath: 'theirs.bin', scan: scan('u2') },
  ];
  return {
    row,
    api: {
      remediationFindings: vi.fn().mockResolvedValue({ items: row, total: 2, page: 1, pageSize: 10 }),
      reviewFinding: vi.fn().mockResolvedValue({ finding: row[0] }),
      updateFinding: vi.fn().mockResolvedValue({ reopened: false, finding: row[0] }),
      list: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 }),
    },
  };
});
vi.mock('@/lib/api', () => ({ ApiError: class ApiError extends Error {}, modelFilesApi: api }));

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <ModelFileFindingSource />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('ModelFileFindingSource', () => {
  it('展示复核/整改状态，只有自己发起扫描的发现可处置', async () => {
    setup();
    expect(await screen.findByText('mine.bin')).toBeTruthy();
    expect(screen.getAllByRole('cell', { name: '未复核' })).toHaveLength(row.length);
    expect(screen.getAllByRole('button', { name: '处置' })).toHaveLength(1);
  });

  it('复核状态筛选里「未复核」「待人工复核」各带说明：两者都计入待复核，不再让人分不清', async () => {
    setup();
    await screen.findByText('mine.bin');
    const select = screen.getByRole('combobox', { name: '按复核状态筛选' });
    expect(
      within(select).getByRole('option', { name: '未复核（尚未处理，计入待复核）' }),
    ).toBeTruthy();
    expect(
      within(select).getByRole('option', { name: '待人工复核（已标记需人工确认，计入待复核）' }),
    ).toBeTruthy();
    expect(within(select).getByRole('option', { name: '全部复核状态' })).toBeTruthy();
  });

  it('处置弹窗提交复核结论与依据', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: '处置' }));
    fireEvent.change(screen.getByLabelText('复核结论'), { target: { value: 'CONFIRMED' } });
    fireEvent.change(screen.getByLabelText('复核依据'), { target: { value: '含 os.system' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(api.reviewFinding).toHaveBeenCalledWith('mine', { status: 'CONFIRMED', reason: '含 os.system' }),
    );
    expect(api.updateFinding).not.toHaveBeenCalled();
  });

  it('选择验证关闭且无同路径复扫时提示先复扫', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: '处置' }));
    fireEvent.change(screen.getByLabelText('整改状态'), { target: { value: 'VERIFIED_CLOSED' } });
    expect(await screen.findByText(/暂无可用复扫：请先对「\/models\/a」重新发起一次扫描/)).toBeTruthy();
  });
});
