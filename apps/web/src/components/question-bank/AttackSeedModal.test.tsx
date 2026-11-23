import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import { AttackSeedModal } from './AttackSeedModal';

const apiMock = vi.hoisted(() => ({
  attackSeedDomains: vi.fn(),
  generateAttackSeeds: vi.fn(),
  saveAttackSeeds: vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { questionSets: apiMock },
}));

function renderModal() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <AttackSeedModal open onClose={() => {}} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('AttackSeedModal 攻击种子泛化', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.attackSeedDomains.mockResolvedValue({
      items: [{ id: 'd1', name: '油气管网', description: null }],
    });
    apiMock.generateAttackSeeds.mockResolvedValue({
      source: 'template',
      fallbackReason: '未配置主攻击模型',
      attackerModel: null,
      total: 3,
      scenarios: [
        { name: '场景1', description: '', category: null, questions: ['问题A', '问题B'] },
        { name: '场景2', description: '', category: null, questions: ['问题C'] },
      ],
    });
    apiMock.saveAttackSeeds.mockResolvedValue({ id: 's1', name: 'x', questionCount: 1 });
  });

  it('实时显示预计生成规模', async () => {
    renderModal();
    fireEvent.change(screen.getByLabelText('场景数量'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('每场景问题数量'), { target: { value: '4' } });
    expect(screen.getByTestId('estimate')).toHaveTextContent(
      '预计生成规模：3 个场景 × 4 题 = 12 题',
    );
  });

  it('场景数量上限 50', async () => {
    renderModal();
    fireEvent.change(screen.getByLabelText('场景数量'), { target: { value: '99' } });
    expect(screen.getByTestId('estimate')).toHaveTextContent('50 个场景');
  });

  it('生成→按场景预览→勾选/删除单题→保存为自有题库，并标明模板生成', async () => {
    renderModal();
    await screen.findByRole('option', { name: '油气管网' });
    await userEvent.selectOptions(screen.getByLabelText('测试领域'), '油气管网');
    await userEvent.selectOptions(screen.getByLabelText('绑定标准'), 'energy');
    await userEvent.click(screen.getByRole('button', { name: '批量生成' }));
    const preview = await screen.findByLabelText('结果预览');
    expect(within(preview).getByText(/模板生成：未配置主攻击模型/)).toBeInTheDocument();
    expect(within(preview).getByRole('region', { name: '场景1' })).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('删除：问题A'));
    await userEvent.click(screen.getByLabelText('选择：问题C'));
    expect(within(preview).getByText('已选 1 题')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '保存为自有题库' }));
    const body = apiMock.saveAttackSeeds.mock.calls[0]![0];
    expect(body.source).toBe('template');
    expect(body.spec.domain).toBe('油气管网');
    expect(body.spec.binding).toEqual({ taxonomy: 'energy', categories: [] });
    expect(body.scenarios).toEqual([
      { name: '场景1', description: '', category: null, questions: ['问题B'] },
    ]);
  });
});
