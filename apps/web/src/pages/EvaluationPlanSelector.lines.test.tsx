import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelTarget } from '@/lib/api';
import { EvaluationPlanSelector } from './EvaluationPlanSelector';

const mocks = vi.hoisted(() => ({ config: vi.fn(), endpoints: vi.fn(), capabilities: vi.fn() }));
vi.mock('@/lib/api', () => ({
  api: {
    modelTargets: { capabilities: mocks.capabilities },
    endpointEvals: { config: mocks.config, endpoints: mocks.endpoints },
  },
}));

const MODEL = { id: 'm1', name: '对话模型', targetType: 'MODEL', isActive: true, supportsVision: true } as ModelTarget;
const APP = { id: 'p1', name: '平台应用', targetType: 'PLATFORM_APP', isActive: true } as ModelTarget;
const EP = {
  id: 'e1',
  name: '研发电脑',
  provider: 'jiandun-fleet',
  targetType: 'ENDPOINT_AGENT',
  isActive: true,
  accessConfig: { fleetEndpointId: 'uuid-1' },
} as unknown as ModelTarget;

function renderSel(targets: ModelTarget[], onSelect = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <EvaluationPlanSelector targets={targets} loading={false} failed={false} retry={() => {}} onSelect={onSelect} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return onSelect;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilities.mockResolvedValue({ platformAppEnabled: true });
  mocks.config.mockResolvedValue({ enabled: false });
  mocks.endpoints.mockResolvedValue([]);
});

describe('新建评估：按三条测评线分两层', () => {
  it('第一层三张卡片，各用一句话写明依据；智能体线与终端线写明参照在研强制国标（非现行）与 TC260-PG-20266A', () => {
    renderSel([MODEL]);
    const content = screen.getByRole('button', { name: /大模型内容安全/ });
    const agent = screen.getByRole('button', { name: /智能体应用安全/ });
    const endpoint = screen.getByRole('button', { name: /终端智能体安全/ });
    expect(content).toHaveTextContent('依据 GB/T 45654');
    expect(agent).toHaveTextContent('参照在研强制国标（非现行）');
    expect(endpoint).toHaveTextContent('对照 TC260-PG-20266A');
    expect(content).toHaveAttribute('aria-pressed', 'true');
    expect(agent).toHaveAttribute('aria-pressed', 'false');
  });

  it('没有必填项和确认步骤：不再有「本次目的」与说明段落，选好对象就能点方案', async () => {
    renderSel([MODEL]);
    expect(screen.queryByText('本次目的')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '上线评估' })).not.toBeInTheDocument();
    expect(screen.queryByText(/不计为通过/)).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('本次评估对象'), 'm1');
    expect(screen.getByRole('button', { name: /题库抽测/ })).toBeEnabled();
  });

  it('内容线：标准评估、题库抽测、多轮红队、多模态越狱', async () => {
    const onSelect = renderSel([MODEL]);
    const group = screen.getByRole('group', { name: '大模型内容安全方案' });
    expect(Array.from(group.querySelectorAll('button')).map((b) => b.querySelector('span')?.textContent)).toEqual([
      '标准评估',
      '题库抽测',
      '多轮红队',
      '多模态越狱',
    ]);
    await userEvent.selectOptions(screen.getByLabelText('本次评估对象'), 'm1');
    await userEvent.click(screen.getByRole('button', { name: /标准评估/ }));
    await userEvent.click(screen.getByRole('button', { name: /题库抽测/ }));
    await userEvent.click(screen.getByRole('button', { name: /多轮红队/ }));
    await userEvent.click(screen.getByRole('button', { name: /多模态越狱/ }));
    expect(onSelect.mock.calls.map((c) => c[0])).toEqual(['standard', 'content', 'redteam', 'multimodal']);
  });

  it('智能体线：沙箱评估、平台应用评估、MCP 专项；平台应用评估只对平台应用对象开放', async () => {
    const onSelect = renderSel([MODEL, APP]);
    await userEvent.click(screen.getByRole('button', { name: /智能体应用安全/ }));
    const group = screen.getByRole('group', { name: '智能体应用安全方案' });
    expect(Array.from(group.querySelectorAll('button')).map((b) => b.querySelector('span')?.textContent)).toEqual([
      '沙箱评估',
      '平台应用评估',
      'MCP 专项',
    ]);
    await userEvent.selectOptions(await screen.findByLabelText('本次评估对象'), 'm1');
    expect(screen.getByRole('button', { name: /沙箱评估/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /平台应用评估/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /平台应用评估/ })).toHaveTextContent('请选择平台应用对象');
    await userEvent.click(screen.getByRole('button', { name: /MCP 专项/ }));
    expect(onSelect).toHaveBeenLastCalledWith('mcp', 'm1');
    await userEvent.selectOptions(screen.getByLabelText('本次评估对象'), 'p1');
    expect(screen.getByRole('button', { name: /沙箱评估/ })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /平台应用评估/ }));
    expect(onSelect).toHaveBeenLastCalledWith('agent', 'p1');
  });

  it('终端线：配置体检、运行态测评；选终端对象自动落到终端线，选回模型对象回到内容线', async () => {
    renderSel([MODEL, EP]);
    await userEvent.selectOptions(await screen.findByLabelText('本次评估对象'), 'e1');
    expect(screen.getByRole('button', { name: /终端智能体安全/ })).toHaveAttribute('aria-pressed', 'true');
    const group = screen.getByRole('group', { name: '终端智能体安全方案' });
    expect(Array.from(group.querySelectorAll('button')).map((b) => b.querySelector('span')?.textContent)).toEqual([
      '配置体检',
      '运行态测评',
    ]);
    await userEvent.selectOptions(screen.getByLabelText('本次评估对象'), 'm1');
    expect(screen.getByRole('button', { name: /大模型内容安全/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('模型对象在终端线：终端方案置灰并要求选终端对象', async () => {
    renderSel([MODEL]);
    await userEvent.selectOptions(screen.getByLabelText('本次评估对象'), 'm1');
    await userEvent.click(screen.getByRole('button', { name: /终端智能体安全/ }));
    const posture = screen.getByRole('button', { name: /^配置体检/ });
    expect(posture).toBeDisabled();
    expect(posture).toHaveTextContent('请选择终端智能体对象');
  });

  it('复测与专家方案收在「显示专家方案」里，不占三条线', async () => {
    renderSel([MODEL]);
    expect(screen.queryByRole('button', { name: /整改复测/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('显示专家方案'));
    for (const name of [/整改复测/, /综合评估/, /间接提示注入/, /导入外部轨迹/])
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
  });
});
