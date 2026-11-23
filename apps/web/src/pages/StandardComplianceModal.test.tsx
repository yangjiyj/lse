import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components/ui/toast';
import { StandardComplianceModal } from './StandardComplianceModal';

const apiMock = vi.hoisted(() => ({
  list: vi.fn(),
  capabilities: vi.fn(),
  test: vi.fn(),
  createGbt: vi.fn(),
  gbtJudgeStatus: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    modelTargets: { list: apiMock.list, capabilities: apiMock.capabilities, test: apiMock.test },
    standardEvaluations: { createGbt: apiMock.createGbt, gbtJudgeStatus: apiMock.gbtJudgeStatus },
  },
  ApiError: class ApiError extends Error {},
}));

const judge = {
  configured: true,
  id: 'j1',
  name: '平台裁判',
  model: 'judge-model',
  lastTestStatus: 'SUCCESS',
  lastTestedAt: null,
  sameAsTarget: false,
  source: 'model_target' as const,
};

function renderModal() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <StandardComplianceModal open onClose={() => undefined} initialTargetId="t1" />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  for (const fn of Object.values(apiMock)) fn.mockReset();
  apiMock.list.mockResolvedValue({
    items: [{ id: 't1', name: '被测模型', model: 'm1', targetType: 'MODEL', isActive: true, hasApiKey: true, lastTestStatus: 'SUCCESS' }],
  });
  apiMock.capabilities.mockResolvedValue({ platformAppEnabled: false });
  apiMock.gbtJudgeStatus.mockResolvedValue(judge);
  apiMock.createGbt.mockResolvedValue({ taskId: 'task1', sampleCount: 1, shortages: [] });
});

describe('国标评估新建弹窗', () => {
  it('生成内容最少 1130，低于时按 1130 处理并写明下限', async () => {
    renderModal();
    const input = (await screen.findByLabelText('生成内容题')) as HTMLInputElement;
    expect(input.value).toBe('1130');
    expect(screen.getByText(/附录 B\.2\.2\.1 b\)：不少于 1000 题（按附录 A 31 项各自下限最少 1130 题）/)).toBeInTheDocument();
    expect(screen.getAllByText('附录 B.2.2.1 d)：不少于 300 题')).toHaveLength(2);
    fireEvent.change(input, { target: { value: '10' } });
    expect(screen.getByText(/已按 1130 题处理/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建并执行（约 1730 次调用）' })).toBeInTheDocument();
    fireEvent.blur(input);
    expect(input.value).toBe('1130');
  });

  it('应拒答或非拒答低于 300：琥珀色试测提示，按钮改成创建试测，提交按 1130 抽', async () => {
    renderModal();
    const refusal = await screen.findByLabelText('应拒答题');
    fireEvent.change(refusal, { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('生成内容题'), { target: { value: '10' } });
    expect(
      screen.getByText('应拒答题低于附录 B.2.2.1 d) 的 300 题下限，本次只能算试测：拒答率不会下结论（显示为「题数不够」）。'),
    ).toBeInTheDocument();
    const button = screen.getByRole('button', { name: '创建试测（约 1460 次调用）' });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await waitFor(() =>
      expect(apiMock.createGbt).toHaveBeenCalledWith({
        modelTargetId: 't1',
        targets: { generation: 1130, refusal: 30, non_refusal: 300 },
        autoStart: true,
      }),
    );
  });

  it('没有评估方式可选：说明执行完自动出结论，人工复核与措施核验可选', async () => {
    renderModal();
    await screen.findByLabelText('应拒答题');
    expect(screen.queryByTestId('gbt-mode-formal')).toBeNull();
    expect(screen.queryByTestId('gbt-mode-quick')).toBeNull();
    expect(screen.getByText(/执行完成后自动出结论，可直接导出评估报告/)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: /^创建并执行/ });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await waitFor(() => expect(apiMock.createGbt).toHaveBeenCalled());
    expect(apiMock.createGbt.mock.calls[0]![0]).not.toHaveProperty('mode');
  });

  it('题数都达标时没有试测提示', async () => {
    renderModal();
    await screen.findByLabelText('应拒答题');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: /^创建并执行/ })).toBeInTheDocument();
  });

  it('裁判模型：已配置显示名称、模型与最近测试', async () => {
    renderModal();
    expect(await screen.findByText('平台裁判 · judge-model')).toBeInTheDocument();
    expect(screen.getByText('最近测试：连通正常')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '测试连通' })).toBeInTheDocument();
  });

  it('裁判模型：没有配置时给出提示和去配置链接', async () => {
    apiMock.gbtJudgeStatus.mockResolvedValue({ ...judge, configured: false, id: null, name: null, model: null, source: null });
    renderModal();
    expect(await screen.findByText('没有配置裁判模型：技术抽检仅关键词，检出能力有限，拒答预判按规则判定。')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '去配置' })).toHaveAttribute('href', '/model-targets');
  });

  it('裁判模型与被测对象相同时提示', async () => {
    apiMock.gbtJudgeStatus.mockResolvedValue({ ...judge, sameAsTarget: true });
    renderModal();
    expect(await screen.findByText('裁判模型不能和被测对象相同')).toBeInTheDocument();
  });

  it('测试连通：成功显示秒数，失败显示原因', async () => {
    apiMock.test.mockResolvedValueOnce({ status: 'SUCCESS', latencyMs: 3400, error: null });
    renderModal();
    fireEvent.click(await screen.findByRole('button', { name: '测试连通' }));
    expect(await screen.findByText('连通正常（3.4 秒）')).toBeInTheDocument();
    expect(apiMock.test).toHaveBeenCalledWith('j1');
    apiMock.test.mockResolvedValueOnce({ status: 'FAILED', latencyMs: 10, error: '上游 502' });
    fireEvent.click(screen.getByRole('button', { name: '测试连通' }));
    expect(await screen.findByText('连通失败：上游 502')).toBeInTheDocument();
  });
});
