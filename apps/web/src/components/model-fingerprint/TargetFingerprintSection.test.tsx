import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TargetFingerprintSection } from './TargetFingerprintSection';

const m = vi.hoisted(() => ({
  list: vi.fn(),
  collect: vi.fn(),
  setBaseline: vi.fn(),
  compare: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  modelFingerprintApi: {
    list: m.list,
    collect: m.collect,
    setBaseline: m.setBaseline,
    compare: m.compare,
  },
}));

const fp = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  modelTargetId: 'mt-1',
  probeVersion: 'v1',
  outputs: [],
  features: [],
  source: 'MANUAL',
  isBaseline: false,
  createdById: 'u-1',
  createdByName: 'alice',
  createdAt: '2026-09-29T08:00:00.000Z',
  ...extra,
});

const probes = Array.from({ length: 10 }, (_, i) => ({
  id: `p${i}`,
  kind: 'identity',
  prompt: 'x',
}));

const listData = (items: unknown[], baselineId: string | null) => ({
  items,
  baselineId,
  probeVersion: 'v1',
  probes,
  defaultThreshold: 0.6,
});

function renderSection(canUpdate = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TargetFingerprintSection targetId="mt-1" canUpdate={canUpdate} />
    </QueryClientProvider>,
  );
}

describe('TargetFingerprintSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('展示历史列表、来源与基线标记及免责声明', async () => {
    m.list.mockResolvedValue(
      listData(
        [fp('fp-2', { source: 'PRE_TASK', createdByName: null }), fp('fp-1', { isBaseline: true })],
        'fp-1',
      ),
    );
    renderSection();
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('任务前自动');
    expect(rows[1]).toHaveTextContent('否');
    expect(within(rows[1]!).getByRole('button', { name: '设为基线' })).toBeInTheDocument();
    expect(within(rows[1]!).getByRole('button', { name: '与基线对比' })).toBeInTheDocument();
    expect(rows[2]).toHaveTextContent('手动');
    expect(rows[2]).toHaveTextContent('alice');
    expect(rows[2]).toHaveTextContent('是');
    expect(within(rows[2]!).queryByRole('button', { name: '设为基线' })).not.toBeInTheDocument();
    expect(screen.getByText('平台内部指纹比对，非模型身份认证结论')).toBeInTheDocument();
    expect(screen.getByText('采集会向被测对象发送 10 次请求')).toBeInTheDocument();
    expect(screen.queryByText('尚未设置基线，任务执行前不会比对')).not.toBeInTheDocument();
    expect(m.list).toHaveBeenCalledWith('mt-1', 20);
  });

  it('无基线时提示任务执行前不会比对，且无对比入口', async () => {
    m.list.mockResolvedValue(listData([fp('fp-1')], null));
    renderSection();
    expect(await screen.findByText('尚未设置基线，任务执行前不会比对')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '与基线对比' })).not.toBeInTheDocument();
  });

  it('采集成功后刷新列表', async () => {
    m.list.mockResolvedValueOnce(listData([], null));
    m.list.mockResolvedValue(listData([fp('fp-new')], null));
    m.collect.mockResolvedValue(fp('fp-new'));
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: '采集指纹' }));
    await waitFor(() => expect(m.collect).toHaveBeenCalledWith('mt-1'));
    expect(await screen.findByText('alice')).toBeInTheDocument();
    expect(m.list).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('采集失败时原样显示后端 502 的 message', async () => {
    m.list.mockResolvedValue(listData([], null));
    const err = Object.assign(new Error('指纹采集失败：上游返回 HTTP 500'), {
      status: 502,
      code: 'FINGERPRINT_COLLECT_FAILED',
    });
    m.collect.mockRejectedValue(err);
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: '采集指纹' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('指纹采集失败：上游返回 HTTP 500');
  });

  it('设为基线调用接口并刷新', async () => {
    m.list.mockResolvedValueOnce(listData([fp('fp-1')], null));
    m.list.mockResolvedValue(listData([fp('fp-1', { isBaseline: true })], 'fp-1'));
    m.setBaseline.mockResolvedValue(fp('fp-1', { isBaseline: true }));
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: '设为基线' }));
    await waitFor(() => expect(m.setBaseline).toHaveBeenCalledWith('mt-1', 'fp-1'));
    await waitFor(() =>
      expect(screen.queryByText('尚未设置基线，任务执行前不会比对')).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: '设为基线' })).not.toBeInTheDocument();
  });

  it('与基线对比展示总相似度、阈值、结论与五个分项', async () => {
    m.list.mockResolvedValue(listData([fp('fp-2'), fp('fp-1', { isBaseline: true })], 'fp-1'));
    m.compare.mockResolvedValue({
      a: { id: 'fp-1', probeVersion: 'v1', createdAt: '', isBaseline: true, source: 'MANUAL' },
      b: { id: 'fp-2', probeVersion: 'v1', createdAt: '', isBaseline: false, source: 'MANUAL' },
      similarity: 0.41,
      threshold: 0.6,
      drift: true,
      components: { ngram: 0.3, length: 0.5, refusal: 0.4, format: 0.9, identity: 0.1 },
      weights: { ngram: 0.4, length: 0.1, refusal: 0.2, format: 0.1, identity: 0.2 },
      comparedProbes: 10,
    });
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: '与基线对比' }));
    const section = await screen.findByRole('region', { name: '比对结果' });
    expect(m.compare).toHaveBeenCalledWith('mt-1', { a: 'fp-1', b: 'fp-2', threshold: 0.6 });
    expect(section).toHaveTextContent('总相似度 0.41');
    expect(section).toHaveTextContent('阈值 0.60');
    const verdict = within(section).getByText('疑似模型被替换');
    expect(verdict.className).toContain('text-severity-critical');
    const rows = within(section).getAllByRole('row');
    expect(rows).toHaveLength(6);
    expect(rows[1]).toHaveTextContent('0.30');
    expect(rows[1]).toHaveTextContent('0.40');
    expect(rows[5]).toHaveTextContent('自述身份');
  });

  it('比对结论一致时不显示替换警示', async () => {
    m.list.mockResolvedValue(listData([fp('fp-2'), fp('fp-1', { isBaseline: true })], 'fp-1'));
    m.compare.mockResolvedValue({
      a: { id: 'fp-1' },
      b: { id: 'fp-2' },
      similarity: 0.93,
      threshold: 0.6,
      drift: false,
      components: { ngram: 0.9, length: 1, refusal: 1, format: 1, identity: 0.8 },
      weights: { ngram: 0.4, length: 0.1, refusal: 0.2, format: 0.1, identity: 0.2 },
      comparedProbes: 10,
    });
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: '与基线对比' }));
    const section = await screen.findByRole('region', { name: '比对结果' });
    expect(within(section).getByText('一致')).toBeInTheDocument();
    expect(section).not.toHaveTextContent('疑似模型被替换');
  });

  it('只读权限隐藏采集与设为基线，仍可对比', async () => {
    m.list.mockResolvedValue(listData([fp('fp-2'), fp('fp-1', { isBaseline: true })], 'fp-1'));
    renderSection(false);
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: '采集指纹' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '设为基线' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '与基线对比' })).toBeInTheDocument();
  });
});
