import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import { RagEvalPage } from '../RagEvalPage';
import { corpus, m, mt, ragTarget, testSet } from './test-fixtures';

const perms = new Set<string>();
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ hasPermission: (c: string) => perms.has(c) }) }));
vi.mock('@/lib/api', async () => {
  const f = await import('./test-fixtures');
  return { ApiError: class ApiError extends Error {}, ragEvalApi: f.m, api: { modelTargets: f.mt } };
});

const BASE = ['rag_eval:read', 'rag_eval:manage', 'rag_eval:run'];
const WRITE = ['model_target:read', 'model_target:create', 'model_target:update'];

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <RagEvalPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function goStep4() {
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: /^1\s*选对象与试连$/ }));
}

const agentTarget = {
  id: 'a1',
  name: '差旅问答应用',
  targetType: 'AGENT_API',
  isRag: false,
  ragOptions: null,
  hasRagRestrictedUploadSecret: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  perms.clear();
  for (const p of [...BASE, ...WRITE]) perms.add(p);
  m.status.mockResolvedValue({ judgeConfigured: true, judgeModelName: 'J', message: null, maxDocumentBytes: 1, formats: [] });
  m.targets.mockResolvedValue([]);
  m.corpora.mockResolvedValue([corpus]);
  m.testSets.mockResolvedValue([testSet]);
  m.runs.mockResolvedValue([]);
  mt.list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 200 });
});

describe('RAG 评估对象入口', () => {
  it('无 RAG 对象时显示新建入口，说明收进提示', async () => {
    await goStep4();
    expect(await screen.findByRole('button', { name: '新建 RAG 评估对象' })).toBeInTheDocument();
    const note = screen.getByRole('note', { name: 'RAG 评估对象说明' });
    expect(note).toHaveAttribute('title', expect.stringContaining('检索上下文与引用来源'));
    expect(note.textContent).not.toMatch(/纯模型接口不连接知识库/);
    expect(screen.getByRole('link', { name: '评估对象' })).toHaveAttribute('href', '/model-targets');
  });

  it('新建弹窗：接入方式固定为智能体应用 API 并声明 RAG，保存后下拉自动选中新对象', async () => {
    const created = { ...agentTarget, id: 'n1', name: '新知识库助手', isRag: true };
    mt.create.mockResolvedValue(created);
    await goStep4();
    fireEvent.click(await screen.findByRole('button', { name: '新建 RAG 评估对象' }));
    const box = screen.getByLabelText('声明为 RAG 应用（开放 RAG 专项评估）');
    expect(box).toBeChecked();
    expect(box).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/对象名称/), '新知识库助手');
    await userEvent.type(screen.getByLabelText(/智能体调用接口 URL/), 'https://agent.example.com/chat');
    await userEvent.type(screen.getByLabelText('检索上下文 JSON 路径'), 'data.contexts');
    m.targets.mockResolvedValue([ragTarget, { ...ragTarget, id: 'n1', name: '新知识库助手' }]);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mt.create).toHaveBeenCalledTimes(1));
    const body = mt.create.mock.calls[0]![0] as Record<string, any>;
    expect(body).toMatchObject({ name: '新知识库助手', targetType: 'AGENT_API', baseUrl: 'https://agent.example.com/chat', isRag: true });
    expect(body.ragOptions).toMatchObject({ contextPath: 'data.contexts', defaultAlignmentMode: 'KB_EXISTING' });
    expect(body.accessConfig).toMatchObject({ authType: 'bearer', responseTextPath: 'data.answer' });
    const select = (await screen.findByLabelText('RAG 评估对象')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('n1'));
  });

  it('已有可声明但未声明的对象可转换：预填弹窗，走更新接口只提交 RAG 字段', async () => {
    mt.list.mockResolvedValue({
      items: [agentTarget, { ...agentTarget, id: 'm1', name: '纯模型', targetType: 'MODEL' }, { ...agentTarget, id: 'r0', name: '已声明', isRag: true }],
      total: 3, page: 1, pageSize: 200,
    });
    mt.update.mockResolvedValue({ ...agentTarget, isRag: true });
    await goStep4();
    const pick = (await screen.findByLabelText('可设为 RAG 应用的评估对象')) as HTMLSelectElement;
    const names = Array.from(pick.options).map((o) => o.textContent);
    expect(names).toEqual(['选择已有智能体应用 API 对象', '差旅问答应用']);
    fireEvent.change(pick, { target: { value: 'a1' } });
    fireEvent.click(screen.getByRole('button', { name: '将已有评估对象设为 RAG 应用' }));
    expect(await screen.findByText('将“差旅问答应用”设为 RAG 应用')).toBeInTheDocument();
    expect(screen.queryByLabelText(/智能体调用接口 URL/)).toBeNull();
    await userEvent.type(screen.getByLabelText('引用来源 JSON 路径'), 'data.citations');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mt.update).toHaveBeenCalledTimes(1));
    const [id, body] = mt.update.mock.calls[0]! as [string, Record<string, any>];
    expect(id).toBe('a1');
    expect(body.isRag).toBe(true);
    expect(body.ragOptions.citationPath).toBe('data.citations');
    expect(body).not.toHaveProperty('accessConfig');
    expect(body).not.toHaveProperty('baseUrl');
  });

  it('无评估对象写权限：不显示新建/转换按钮，提示联系管理员', async () => {
    for (const p of WRITE) perms.delete(p);
    await goStep4();
    expect(await screen.findByText('请联系管理员配置 RAG 评估对象。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '新建 RAG 评估对象' })).toBeNull();
    expect(screen.queryByRole('button', { name: '将已有评估对象设为 RAG 应用' })).toBeNull();
    expect(mt.list).not.toHaveBeenCalled();
  });

  it('已有 RAG 对象时下拉旁仍有说明与新建入口', async () => {
    m.targets.mockResolvedValue([ragTarget]);
    await goStep4();
    expect(await screen.findByLabelText('RAG 评估对象')).toBeInTheDocument();
    expect(screen.getByRole('note', { name: 'RAG 评估对象说明' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建 RAG 评估对象' })).toBeInTheDocument();
  });

  it('判定模型未配置：只显示中文探活原因与短链接', async () => {
    m.status.mockResolvedValue({ judgeConfigured: false, judgeModelName: null, message: '未配置评估模型', maxDocumentBytes: 1, formats: [], judgeSettingsPath: '/settings#independent-judge-model' });
    m.checkJudge.mockResolvedValue({ available: false, message: '判定模型当前不可用：未配置独立判定模型。' });
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('判定模型当前不可用：未配置独立判定模型。去配置');
    expect(alert.textContent).not.toMatch(/未配置评估模型：\s*未配置评估模型/);
    expect(screen.getByRole('link', { name: '去配置' })).toHaveAttribute('href', '/settings#independent-judge-model');
  });
});


describe('RAG 接入预设与试连', () => {
  it('Dify 对话应用只需地址和密钥即可生成接入配置，密钥不进入模板', async () => {
    mt.create.mockResolvedValue({ ...agentTarget, id: 'dify1', isRag: true });
    await goStep4();
    fireEvent.click(await screen.findByRole('button', { name: '新建 RAG 评估对象' }));
    fireEvent.change(screen.getByLabelText('应用类型'), { target: { value: 'chat' } });
    await userEvent.type(screen.getByLabelText(/对象名称/), 'Dify 助手');
    await userEvent.type(screen.getByLabelText(/^应用地址/), 'http://example.com:18094');
    await userEvent.type(screen.getByLabelText(/^应用 API Key/), 'app-test-only');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mt.create).toHaveBeenCalledTimes(1));
    const body = mt.create.mock.calls[0]![0] as any;
    expect(body.baseUrl).toBe('http://example.com:18094/v1/chat-messages');
    expect(body.apiKey).toBe('app-test-only');
    expect(body.accessConfig.requestTemplate.query).toBe('{{question}}');
    expect(JSON.stringify(body.accessConfig)).not.toContain('app-test-only');
    expect(body.ragOptions.citationIdField).toBe('document_name');
  });
  it('试连失败显示原因并禁止下一步，重新试连通过后放行', async () => {
    m.targets.mockResolvedValue([ragTarget]);
    m.checkTarget.mockResolvedValueOnce({ ok: false, httpStatus: 401, latencyMs: 2, checks: [{ key: 'answer', label: '应用连接', status: 'fail', reason: '认证失败，请检查应用 API Key。' }] });
    await goStep4();
    const next = await screen.findByRole('button', { name: '下一步：知识对齐' });
    expect(next).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '试连' }));
    expect(await screen.findByText('认证失败，请检查应用 API Key。')).toBeInTheDocument();
    expect(next).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '试连' }));
    await waitFor(() => expect(next).toBeEnabled());
  });
  it('判定模型探活失败时阻止发起并显示中文原因', async () => {
    m.targets.mockResolvedValue([ragTarget]);
    m.checkJudge.mockResolvedValueOnce({ available: false, message: '判定模型当前不可用：模型无权限。' });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /^5\s*运行与结果$/ }));
    expect(await screen.findByText('判定模型当前不可用：模型无权限。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发起评估' })).toBeDisabled();
    expect(m.checkJudge).toHaveBeenCalledWith('t1');
  });
});
