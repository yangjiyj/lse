import { describe, it, expect, vi, beforeEach } from 'vitest';
import type React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import { AgentFanoutModal } from './AgentFanoutModal';

const apiMock = vi.hoisted(() => ({
  listModels: vi.fn(),
  fanout: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    status: number;
    code?: string;
    constructor(m: string, status = 500, code?: string) {
      super(m);
      this.status = status;
      this.code = code;
    }
  },
  api: {
    modelTargets: { list: apiMock.listModels },
    agentEvals: { fanout: apiMock.fanout },
  },
}));

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ToastProvider>{ui}</ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const eightFindings = [
  // 后端返回时已按 lethal→score 降序，前端保序即可
  {
    channel: 'html_comment',
    verdict: 'FAIL',
    trifectaTags: { privilegedAccess: true, untrustedInput: true, exfilCapable: true },
    lethal: true,
    score: 3,
    exfilHits: 1,
    evidence: 'real callback',
  },
  {
    channel: 'csv_header',
    verdict: 'FAIL',
    trifectaTags: { privilegedAccess: true, untrustedInput: true, exfilCapable: true },
    lethal: true,
    score: 3,
    exfilHits: 1,
    evidence: 'real callback',
  },
  {
    channel: 'html_body',
    verdict: 'PASS',
    trifectaTags: { privilegedAccess: true, untrustedInput: true, exfilCapable: false },
    lethal: false,
    score: 2,
    exfilHits: 0,
    evidence: 'no exfil',
  },
  {
    channel: 'markdown_link',
    verdict: 'PASS',
    trifectaTags: { privilegedAccess: true, untrustedInput: true, exfilCapable: false },
    lethal: false,
    score: 2,
    exfilHits: 0,
    evidence: 'no exfil',
  },
  {
    channel: 'json_field',
    verdict: 'PASS',
    trifectaTags: { privilegedAccess: true, untrustedInput: true, exfilCapable: false },
    lethal: false,
    score: 2,
    exfilHits: 0,
    evidence: 'no exfil',
  },
  {
    channel: 'rss_item',
    verdict: 'PASS',
    trifectaTags: { privilegedAccess: true, untrustedInput: true, exfilCapable: false },
    lethal: false,
    score: 2,
    exfilHits: 0,
    evidence: 'no exfil',
  },
  {
    channel: 'multilingual',
    verdict: 'PASS',
    trifectaTags: { privilegedAccess: true, untrustedInput: true, exfilCapable: false },
    lethal: false,
    score: 2,
    exfilHits: 0,
    evidence: 'no exfil',
  },
  {
    channel: 'http_header',
    verdict: 'PASS',
    trifectaTags: { privilegedAccess: true, untrustedInput: false, exfilCapable: false },
    lethal: false,
    score: 1,
    exfilHits: 0,
    evidence: 'no exfil',
  },
];

beforeEach(() => {
  apiMock.listModels.mockReset();
  apiMock.fanout.mockReset();
  apiMock.listModels.mockResolvedValue({
    items: [{ id: 't1', name: 'Test Target', model: 'gpt-x', targetType: 'MODEL', isActive: true }],
    total: 1,
    page: 1,
    pageSize: 20,
  });
});

describe('AgentFanoutModal', () => {
  it('选被测对象后开始评估，用正确 body 调 fanout', async () => {
    apiMock.fanout.mockResolvedValue({ runToken: 'fanout-xxx', findings: [], failedChannels: [] });
    render(wrap(<AgentFanoutModal open={true} onClose={() => {}} />));
    await screen.findByText(/Test Target/);
    await userEvent.selectOptions(screen.getByLabelText(/评估对象/), 't1');
    await userEvent.click(screen.getByRole('button', { name: /开始评估/ }));
    await waitFor(() => expect(apiMock.fanout).toHaveBeenCalledTimes(1));
    // 默认「随机」场景：后端 body 带上 modelTargetId + 随机场景的任务/机密
    const body = apiMock.fanout.mock.calls[0]![0];
    expect(body).toEqual(
      expect.objectContaining({
        modelTargetId: 't1',
        secretHint: expect.any(String),
        benignTaskZh: expect.any(String),
      }),
    );
    expect(body.secretHint.length).toBeGreaterThan(0);
    expect(body.benignTaskZh.length).toBeGreaterThan(0);
  });

  it('选指定场景（代码助手）时，用该场景的任务与机密调 fanout', async () => {
    apiMock.fanout.mockResolvedValue({ runToken: 'fanout-c', findings: [], failedChannels: [] });
    render(wrap(<AgentFanoutModal open={true} onClose={() => {}} />));
    await screen.findByText(/Test Target/);
    await userEvent.selectOptions(screen.getByLabelText(/评估对象/), 't1');
    await userEvent.selectOptions(screen.getByLabelText(/评估场景/), 'coding');
    await userEvent.click(screen.getByRole('button', { name: /开始评估/ }));
    await waitFor(() => expect(apiMock.fanout).toHaveBeenCalledTimes(1));
    expect(apiMock.fanout).toHaveBeenCalledWith(
      expect.objectContaining({
        secretHint: expect.stringContaining('API 密钥'),
        benignTaskZh: expect.stringContaining('接口文档'),
      }),
    );
  });

  it('自定义场景：展开输入框并把手填的值传给 fanout', async () => {
    apiMock.fanout.mockResolvedValue({ runToken: 'fanout-u', findings: [], failedChannels: [] });
    render(wrap(<AgentFanoutModal open={true} onClose={() => {}} />));
    await screen.findByText(/Test Target/);
    await userEvent.selectOptions(screen.getByLabelText(/评估对象/), 't1');
    await userEvent.selectOptions(screen.getByLabelText(/评估场景/), 'custom');
    await userEvent.type(screen.getByLabelText(/诱饵数据描述/), '数据库口令');
    await userEvent.type(screen.getByLabelText(/业务任务描述/), '翻译这个页面');
    await userEvent.click(screen.getByRole('button', { name: /开始评估/ }));
    await waitFor(() => expect(apiMock.fanout).toHaveBeenCalledTimes(1));
    expect(apiMock.fanout).toHaveBeenCalledWith(
      expect.objectContaining({ secretHint: '数据库口令', benignTaskZh: '翻译这个页面' }),
    );
  });

  it('返回 findings 后按顺序渲染 8 行、结果用大白话、并说清做了什么', async () => {
    apiMock.fanout.mockResolvedValue({
      runToken: 'fanout-yyy',
      findings: eightFindings,
      failedChannels: [],
    });
    render(wrap(<AgentFanoutModal open={true} onClose={() => {}} />));
    await screen.findByText(/Test Target/);
    await userEvent.selectOptions(screen.getByLabelText(/评估对象/), 't1');
    await userEvent.click(screen.getByRole('button', { name: /开始评估/ }));
    const rows = await screen.findAllByTestId('fanout-finding-row');
    expect(rows).toHaveLength(8);
    // 前两行是发生外发的通道，展示中文通道名而非原始英文 id。
    const firstTwoText = `${rows[0]!.textContent} ${rows[1]!.textContent}`;
    expect(firstTwoText).toMatch(/注释/);
    expect(firstTwoText).toMatch(/CSV/);
    expect(screen.getAllByText('发生外发').length).toBe(2);
    expect(screen.getAllByText('未观测到外发').length).toBe(6);
    expect(screen.getByText(/评估范围/)).toBeInTheDocument();
    expect(screen.getByText(/发现风险/)).toBeInTheDocument();
  });

  it('后端 403 fanout_disabled 时展示错误、回到表单', async () => {
    const { ApiError } = await import('@/lib/api');
    apiMock.fanout.mockRejectedValue(new ApiError('真通道 fan-out 未启用', 403, 'fanout_disabled'));
    render(wrap(<AgentFanoutModal open={true} onClose={() => {}} />));
    await screen.findByText(/Test Target/);
    await userEvent.selectOptions(screen.getByLabelText(/评估对象/), 't1');
    await userEvent.click(screen.getByRole('button', { name: /开始评估/ }));
    await waitFor(() => {
      const errorTexts = screen.queryAllByText(/未启用/);
      expect(errorTexts.length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getByRole('button', { name: /开始评估/ })).toBeInTheDocument();
  });
});
