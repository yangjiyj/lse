import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import { AgentEvalModal } from './AgentEvalModal';

const mocks = vi.hoisted(() => ({ list: vi.fn(), preview: vi.fn(), run: vi.fn(), packs: vi.fn() }));
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    modelTargets: { list: mocks.list },
    agentEvals: { preview: mocks.preview, run: mocks.run, packs: mocks.packs },
  },
}));
vi.mock('@/lib/use-platform-app-enabled', () => ({ usePlatformAppEnabled: () => true }));
vi.mock('@/lib/use-demo-mode', () => ({ useDemoMode: () => ({ mode: 'demo' }) }));

function renderModal() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter><ToastProvider><AgentEvalModal open initialTargetId="platform" onClose={() => {}} /></ToastProvider></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AgentEvalModal 平台场景', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue({ items: [
      { id: 'platform', name: '测试应用', model: 'dify', targetType: 'PLATFORM_APP', isActive: true },
      { id: 'model', name: '测试模型', model: 'test', targetType: 'MODEL', isActive: true },
    ] });
    mocks.preview.mockImplementation(async (body) => ({
      ...body, samples: [{ metadata: { prerequisites: ['请先在测试应用知识库中放置含 LSE-CANARY-TEST 的内部蜜罐文档。'] } }],
    }));
    mocks.packs.mockResolvedValue({ items: [] });
    mocks.run.mockResolvedValue({ taskId: 'task', sampleCount: 20 });
  });

  it('自动预览平台样本，显示蜜罐准备说明，并将相同种子与样本包提交', async () => {
    renderModal();
    expect(await screen.findByText(/请先在测试应用知识库中放置含 LSE-CANARY-TEST/)).toBeInTheDocument();
    const preview = mocks.preview.mock.calls.at(-1)![0];
    expect(preview.packIds).toEqual(['platform-app-v1']);
    expect(preview.seed).toEqual(expect.any(String));
    expect(preview.seed.length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('追加四类沙箱场景')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /开始评估/ }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({
      modelTargetId: 'platform', packIds: ['platform-app-v1'], seed: preview.seed, sampleCount: preview.sampleCount, agenticScenarios: false,
    })));
  });

  it('模型取消全部风险范围后切换平台仍可预览并开始', async () => {
    renderModal();
    await screen.findByText(/请先在测试应用知识库中放置含 LSE-CANARY-TEST/);
    await userEvent.selectOptions(screen.getByLabelText('评估对象'), 'model');
    await userEvent.click(screen.getByRole('button', { name: /高级配置/ }));
    const field = screen.getByText('风险范围').parentElement!;
    for (const checkbox of within(field).getAllByRole('checkbox')) {
      if ((checkbox as HTMLInputElement).checked) await userEvent.click(checkbox);
    }
    await userEvent.type(screen.getByLabelText('复现编号'), 'platform-after-empty');
    mocks.preview.mockClear();
    await userEvent.selectOptions(screen.getByLabelText('评估对象'), 'platform');
    await waitFor(() => expect(mocks.preview).toHaveBeenCalledWith(expect.objectContaining({
      seed: 'platform-after-empty', packIds: ['platform-app-v1'],
    })));
    await waitFor(() => expect(screen.getByRole('button', { name: /开始评估/ })).toBeEnabled());
    expect(screen.getByText(/请先在测试应用知识库中放置含 LSE-CANARY-TEST/)).toBeInTheDocument();
  });

  it('高级配置隐藏模拟控制，清空手填种子后预览与执行沿用同一自动种子', async () => {
    renderModal();
    await screen.findByText(/请先在测试应用知识库中放置含 LSE-CANARY-TEST/);
    await userEvent.click(screen.getByRole('button', { name: /高级配置/ }));
    expect(screen.queryByText('风险范围')).not.toBeInTheDocument();
    expect(screen.queryByText('自适应攻击：')).not.toBeInTheDocument();
    expect(screen.queryByText('评估强度')).not.toBeInTheDocument();
    const initialSeed = mocks.preview.mock.calls.at(-1)![0].seed;
    await userEvent.type(screen.getByLabelText('复现编号'), 'manual');
    await userEvent.clear(screen.getByLabelText('复现编号'));
    expect(screen.getByLabelText('复现编号')).toHaveAttribute('placeholder', initialSeed);
    await userEvent.click(screen.getByRole('button', { name: /开始评估/ }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ seed: initialSeed, packIds: ['platform-app-v1'] })));
  });

  it('平台对象默认选中标准场景（v1），预览与提交都带 platform-app-v1', async () => {
    renderModal();
    await screen.findByText(/请先在测试应用知识库中放置含 LSE-CANARY-TEST/);
    const group = screen.getByRole('radiogroup', { name: '平台场景包' });
    expect(within(group).getByRole('radio', { name: /标准场景（v1）/ })).toBeChecked();
    expect(within(group).getByRole('radio', { name: /扩展场景（v2/ })).not.toBeChecked();
    expect(mocks.preview.mock.calls.every(([body]) => body.packIds[0] === 'platform-app-v1')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: /开始评估/ }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
    expect(mocks.run.mock.calls[0]![0].packIds).toEqual(['platform-app-v1']);
  });

  it('切到扩展场景（v2）后，预览与提交都带 platform-app-v2', async () => {
    renderModal();
    await screen.findByText(/请先在测试应用知识库中放置含 LSE-CANARY-TEST/);
    mocks.preview.mockClear();
    await userEvent.click(screen.getByRole('radio', { name: /扩展场景（v2/ }));
    expect(screen.getByRole('radio', { name: /扩展场景（v2/ })).toBeChecked();
    await waitFor(() => expect(mocks.preview).toHaveBeenCalledWith(expect.objectContaining({ packIds: ['platform-app-v2'] })));
    await waitFor(() => expect(screen.getByRole('button', { name: /开始评估/ })).toBeEnabled());
    const preview = mocks.preview.mock.calls.at(-1)![0];
    expect(mocks.preview.mock.calls.every(([body]) => body.packIds[0] === 'platform-app-v2')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: /开始评估/ }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({
      modelTargetId: 'platform', packIds: ['platform-app-v2'], seed: preview.seed, sampleCount: preview.sampleCount, agenticScenarios: false,
    })));
  });

  it('高风险操作确认场景：平台对象不显示，模型对象默认勾选（覆盖 8 项要求之一），取消勾选后不提交', async () => {
    renderModal();
    await screen.findByText(/请先在测试应用知识库中放置含 LSE-CANARY-TEST/);
    expect(screen.queryByLabelText('追加高风险操作确认场景')).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('评估对象'), 'model');
    const box = screen.getByLabelText('追加高风险操作确认场景') as HTMLInputElement;
    expect(box.checked).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: /开始评估/ }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ modelTargetId: 'model', hitlScenarios: true })));
    mocks.run.mockClear();
    await userEvent.click(box);
    await userEvent.click(screen.getByRole('button', { name: /开始评估/ }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalled());
    expect(mocks.run.mock.calls.at(-1)![0]).not.toHaveProperty('hitlScenarios');
  });

  it('非平台对象不显示平台场景包选项，提交沿用原样本包，样本包列表仍隐藏 v1', async () => {
    mocks.packs.mockResolvedValue({ items: [
      { id: 'builtin-agent-attacks', version: 'builtin-v1', templateCount: 10, riskSurfaces: [], sourceRefs: [], templates: [] },
      { id: 'platform-app-v1', version: 'platform-app-v1', templateCount: 5, riskSurfaces: [], sourceRefs: [], templates: [] },
    ] });
    renderModal();
    await screen.findByText(/请先在测试应用知识库中放置含 LSE-CANARY-TEST/);
    expect(screen.getByRole('radiogroup', { name: '平台场景包' })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('评估对象'), 'model');
    expect(screen.queryByRole('radiogroup', { name: '平台场景包' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /场景（v/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /高级配置/ }));
    expect(await screen.findByText('内置智能体攻击包')).toBeInTheDocument();
    expect(screen.queryByText('platform-app-v1')).not.toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: '平台场景包' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /开始评估/ }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({
      modelTargetId: 'model', packIds: ['builtin-agent-attacks'],
    })));
  });

  it('关闭后重新打开，平台场景包恢复为默认的标准场景（v1）', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (open: boolean) => (
      <QueryClientProvider client={client}>
        <MemoryRouter><ToastProvider><AgentEvalModal open={open} initialTargetId="platform" onClose={() => {}} /></ToastProvider></MemoryRouter>
      </QueryClientProvider>
    );
    const view = render(tree(true));
    await screen.findByText(/请先在测试应用知识库中放置含 LSE-CANARY-TEST/);
    await userEvent.click(screen.getByRole('radio', { name: /扩展场景（v2/ }));
    expect(screen.getByRole('radio', { name: /扩展场景（v2/ })).toBeChecked();
    view.rerender(tree(false));
    view.rerender(tree(true));
    expect(await screen.findByRole('radio', { name: /标准场景（v1）/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /扩展场景（v2/ })).not.toBeChecked();
  });

  it('场景包说明写明多轮、变体更多、耗时更长，面向用户的文案不含内部词', async () => {
    renderModal();
    await screen.findByText(/请先在测试应用知识库中放置含 LSE-CANARY-TEST/);
    const text = screen.getByRole('radiogroup', { name: '平台场景包' }).textContent ?? '';
    expect(text).toContain('标准场景（v1）');
    expect(text).toContain('扩展场景（v2：多轮、更多变体）');
    expect(text).toMatch(/多轮对话/);
    expect(text).toMatch(/更多提问变体/);
    expect(text).toMatch(/预计执行时间更长/);
    expect(text).not.toMatch(/canary|honeypot|测试/i);
  });
});
