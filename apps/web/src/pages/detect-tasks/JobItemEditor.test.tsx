import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DetectJobItemKind } from '@lse/shared';
import { JobItemEditor, defaultJobItemParams, jobItemProblem } from './JobItemEditor';

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  assetDiscoveryApi: { scope: vi.fn().mockResolvedValue({ entries: [], ports: [443] }) },
}));

function renderEditor(kind: DetectJobItemKind, onChange = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <JobItemEditor kind={kind} value={defaultJobItemParams(kind)} onChange={onChange} />
    </QueryClientProvider>,
  );
  return onChange;
}

describe('JobItemEditor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('资产测绘不勾授权时 onChange 给出的值不合法，勾上后合法', async () => {
    const user = userEvent.setup();
    const onChange = renderEditor('asset_discovery');
    await user.type(screen.getByLabelText(/扫描目标/), '10.0.0.0/30');
    await user.type(screen.getByLabelText(/端口/), '443');
    let [params, problem] = onChange.mock.calls.at(-1)!;
    expect(params).toEqual({ targets: ['10.0.0.0/30'], ports: [443], confirm: false });
    expect(problem).toBe('需确认已获授权对目标主动探测');

    await user.click(screen.getByRole('checkbox', { name: '已获授权对目标主动探测' }));
    [params, problem] = onChange.mock.calls.at(-1)!;
    expect(params).toEqual({ targets: ['10.0.0.0/30'], ports: [443], confirm: true });
    expect(problem).toBeNull();
  });

  it('资产测绘：网段没有端口、端口写法不对时不合法', async () => {
    const user = userEvent.setup();
    const onChange = renderEditor('asset_discovery');
    await user.click(screen.getByRole('checkbox', { name: '已获授权对目标主动探测' }));
    await user.type(screen.getByLabelText(/扫描目标/), '10.0.0.0/30');
    expect(onChange.mock.calls.at(-1)![1]).toBe('请选择扫描端口');
    await user.type(screen.getByLabelText(/端口/), '70000');
    expect(onChange.mock.calls.at(-1)![1]).toBe('端口写法不正确');
  });

  it('参数检查与后端必填项一致', () => {
    expect(jobItemProblem('eval_task', defaultJobItemParams('eval_task'))).toBe('请选择评估对象');
    expect(
      jobItemProblem('eval_task', { modelTargetId: 'm', questionSetIds: ['q'], engines: [] }),
    ).toBeNull();
    expect(jobItemProblem('model_file_scan', { source: 'library', uploadId: '' })).toBe(
      '请选择模型库文件',
    );
    expect(jobItemProblem('model_file_scan', { source: 'directory', path: '/models' })).toBeNull();
    expect(jobItemProblem('corpus_scan', { sourceScanId: 's', ruleSetId: null })).toBeNull();
    expect(jobItemProblem('fleet_posture', { endpointId: 'e', items: [] })).toBe(
      '请至少选择一个体检项',
    );
    // URL 和「主机:端口」自带端口，不要求另选端口
    expect(
      jobItemProblem('asset_discovery', {
        targets: ['https://a.example.com', 'b.example.com:8000'],
        ports: [],
        confirm: true,
      }),
    ).toBeNull();
  });
});
