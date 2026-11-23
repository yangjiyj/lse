import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import { MutationButton } from './MutationModal';

const apiMock = vi.hoisted(() => ({
  mutationStrategies: vi.fn(),
  createMutation: vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { questionSets: apiMock },
}));

function renderButton() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MutationButton setId="set-1" setName="安全提示词" />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('MutationModal 变异扩展', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.mutationStrategies.mockResolvedValue({
      llmConfigured: false,
      limits: { maxSampleSize: 1000, maxStrategies: 10, maxOutput: 5000 },
      items: [
        {
          id: 'base64',
          label: 'Base64 编码',
          family: 'encoding',
          familyLabel: '编码转换',
          description: 'Base64 编码：转成编码形式',
          requiresLlm: false,
        },
        {
          id: 'hex',
          label: 'Hex 编码',
          family: 'encoding',
          familyLabel: '编码转换',
          description: 'Hex 编码：转成编码形式',
          requiresLlm: false,
        },
        {
          id: 'llm_rewrite',
          label: '大模型改写',
          family: 'llm',
          familyLabel: '大模型改写',
          description: '需配置',
          requiresLlm: true,
        },
      ],
    });
    apiMock.createMutation.mockResolvedValue({
      id: 'new-1',
      name: '安全提示词 · 变异扩展',
      seed: 'ab12cd34',
      sourceTotal: 1000,
      sampled: 100,
      total: 198,
      skipped: 2,
      perStrategy: [
        { id: 'base64', label: 'Base64 编码', count: 99 },
        { id: 'hex', label: 'Hex 编码', count: 99 },
      ],
    });
  });

  it('弹窗按分组展示策略，改写类在未配置模型时禁用，预估随参数变化', async () => {
    renderButton();
    await userEvent.click(screen.getByRole('button', { name: '变异扩展' }));
    expect(await screen.findByRole('region', { name: '编码转换' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '大模型改写' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '生成新样本库' })).toBeDisabled();
    await userEvent.click(screen.getByLabelText('Base64 编码'));
    await userEvent.click(screen.getByLabelText('Hex 编码'));
    fireEvent.change(screen.getByLabelText('抽样题数'), { target: { value: '200' } });
    fireEvent.change(screen.getByLabelText('每题套用几种策略'), { target: { value: '2' } });
    expect(screen.getByTestId('estimate').textContent).toContain('最多 400 题');
  });

  it('提交后调用接口并展示各策略条数与种子', async () => {
    renderButton();
    await userEvent.click(screen.getByRole('button', { name: '变异扩展' }));
    await userEvent.click(await screen.findByLabelText('Base64 编码'));
    await userEvent.click(screen.getByLabelText('Hex 编码'));
    await userEvent.click(screen.getByRole('button', { name: '生成新样本库' }));
    await waitFor(() =>
      expect(apiMock.createMutation).toHaveBeenCalledWith({
        sourceSetId: 'set-1',
        sampleSize: 100,
        seed: undefined,
        strategies: ['base64', 'hex'],
        perSeed: 1,
        name: '安全提示词 · 变异扩展',
      }),
    );
    const panel = await screen.findByLabelText('生成结果');
    expect(panel.textContent).toContain('198');
    expect(panel.textContent).toContain('ab12cd34');
    expect(panel.textContent).toContain('Base64 编码');
  });
});
