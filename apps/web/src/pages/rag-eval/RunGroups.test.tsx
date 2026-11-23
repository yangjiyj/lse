import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { RunGroups } from './RunGroups';
import { JudgeNotice } from './JudgeNotice';
import { ChecklistView } from './TargetCheckPanel';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConnectionProbe, targetProbeKey } from './ConnectionProbe';
import { groups } from './test-fixtures';

it('只跑安全题时合并未涉及指标组', () => {
  render(<RunGroups groups={{ ...groups, generation: groups.generation.map(m => ({ ...m, applicable: 0, samples: 0 })) }} />);
  expect(screen.getByText('本次未涉及：生成质量、检索质量')).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: '生成质量' })).toBeNull();
  expect(screen.queryByRole('region', { name: '检索质量' })).toBeNull();
  expect(screen.getByRole('region', { name: '安全项' })).toBeInTheDocument();
});

it('部分评估的通过率与覆盖范围、出错原因显示在同一格', () => {
  render(<RunGroups groups={{ ...groups, security: [{ ...groups.security[0]!, label: '越权读取其他文档', applicable: 2, samples: 1, passRate: 1, notEvaluated: 1, notEvaluatedReasons: [{ reason: '出错：请求超时', count: 1 }] }] }} />);
  const row = screen.getByText('越权读取其他文档').closest('tr')!;
  const cell = within(row).getByText('100%（1/2 已评估）').closest('td')!;
  expect(within(cell).getByText('出错：请求超时（1）')).toBeInTheDocument();
  expect(within(row).queryByText('100.0%')).toBeNull();
});

it('完整覆盖保留原有通过率及样本数', () => {
  render(<RunGroups groups={groups} />);
  const row = screen.getByText('正确性').closest('tr')!;
  expect(within(row).getByText('50.0%')).toBeInTheDocument();
  expect(within(row).getByText('2/2')).toBeInTheDocument();
});

describe('客户文案', () => {
  it('模型环境变量不显示，链接简短', () => {
    render(<MemoryRouter><JudgeNotice message="未配置 LLM_JUDGE_MODEL / LLM_JUDGE_BASE_URL" path="/settings" /></MemoryRouter>);
    expect(screen.getByRole('alert').textContent).toBe('判定模型当前不可用：未配置。去配置');
  });
  it('清单只保留防误用提示，不透传模板和越权长说明', () => {
    render(<ChecklistView checks={[
      { key: 'testKnowledgeBaseId', label: '测试知识库', ok: false, required: false, hint: '请填写 {{knowledge_base_id}}' },
      { key: 'restricted', label: '受限知识库', ok: false, required: false, hint: '未配置时越权读取项显示未评估' },
      { key: 'contextPath', label: '检索上下文路径（contextPath）', ok: false, required: false, hint: '未配置时忠实度记“未评估”' },
    ]} />);
    expect(screen.getByRole('list').textContent).not.toMatch(/knowledge_base_id|contextPath|越权读取项/);
    expect(screen.getByText('未配置时忠实度记“未评估”')).toBeInTheDocument();
  });
});

it('试连配置结果也隐藏内部模板，保留实际连接失败原因', () => {
  const client = new QueryClient();
  client.setQueryData(targetProbeKey('t1', 'KB_EXISTING'), { ok: false, httpStatus: 401, latencyMs: 12, checks: [
    { key: 'config.testKnowledgeBaseId', label: '测试知识库标识', status: 'unconfigured', reason: '请填写 {{knowledge_base_id}}' },
    { key: 'answer', label: '应用连接与回答抽取', status: 'fail', reason: '应用密钥无效，请检查 API Key。' },
  ] });
  render(<QueryClientProvider client={client}><ConnectionProbe id="t1" mode="KB_EXISTING" /></QueryClientProvider>);
  expect(screen.getByLabelText('试连结果').textContent).not.toContain('{{knowledge_base_id}}');
  expect(screen.getByText('应用密钥无效，请检查 API Key。')).toBeInTheDocument();
  expect(screen.getByText(/试连失败 · HTTP 401/)).toBeInTheDocument();
});

it('平均值指标部分评估时同样展示覆盖比例', () => {
  render(<RunGroups groups={{ ...groups, retrieval: [{ ...groups.retrieval[1]!, applicable: 2, samples: 1, average: 0.75 }] }} />);
  expect(screen.getByText('0.750（1/2 已评估）')).toBeInTheDocument();
});
