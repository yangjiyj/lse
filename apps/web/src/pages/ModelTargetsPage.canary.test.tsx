import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import { ModelTargetsPage } from './ModelTargetsPage';

const m = vi.hoisted(() => ({
  capabilities: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    modelTargets: {
      capabilities: m.capabilities,
      list: m.list,
      create: m.create,
      update: m.update,
      remove: vi.fn(),
      test: vi.fn(),
      diagnose: vi.fn(),
      diagnoseSaved: vi.fn(),
      batchTest: vi.fn(),
    },
    gatewayLogs: { analyze: vi.fn() },
    evalTasks: { list: vi.fn(), remove: vi.fn() },
    systemSettings: { get: vi.fn().mockResolvedValue({ gateway: { gatewayBaseUrl: '' } }) },
  },
}));

vi.mock('@/lib/auth', () => ({ useAuth: () => ({ hasPermission: () => true }) }));

// 读取接口把暗号脱敏成 hash:xxxx；表单只能据此判断“已配置”，不能显示也不能回传。
const MASKED_KNOWLEDGE = 'hash:0123456789ab';
const MASKED_SYSTEM = 'hash:ba9876543210';

const platformTarget = (name: string, accessConfig: Record<string, unknown>) => ({
  id: 'platform-1',
  name,
  targetType: 'PLATFORM_APP',
  provider: 'platform-app',
  model: 'platform-app',
  baseUrl: String(accessConfig.baseUrl),
  apiKeyMasked: 'app-****',
  hasApiKey: true,
  extraHeaders: null,
  defaultParams: null,
  accessConfig,
  isGlobal: false,
  isActive: true,
  lastTestStatus: null,
  lastTestedAt: null,
  createdAt: '2026-10-31T00:00:00.000Z',
  updatedAt: '2026-10-31T00:00:00.000Z',
  createdBy: null,
});

const cozeTarget = () =>
  platformTarget('扣子客服', {
    platform: 'coze',
    baseUrl: 'https://api.coze.cn',
    botId: 'bot-123',
    user: 'eval-user',
    knowledgeCanary: MASKED_KNOWLEDGE,
  });

const difyTarget = () =>
  platformTarget('Dify 客服', {
    platform: 'dify',
    baseUrl: 'https://dify.example.com/v1',
    appMode: 'chat',
    user: 'eval-user',
    inputs: { region: 'cn' },
    systemCanary: MASKED_SYSTEM,
  });

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <ModelTargetsPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function startCreate(platform: 'dify' | 'coze') {
  renderPage();
  await userEvent.click(screen.getByRole('button', { name: /新建评估对象/ }));
  await screen.findByRole('option', { name: '平台智能体（Dify/扣子）' });
  await userEvent.selectOptions(screen.getByLabelText('对象类型'), 'PLATFORM_APP');
  await userEvent.type(screen.getByLabelText(/^名称/), '新平台对象');
  await userEvent.selectOptions(screen.getByLabelText('平台'), platform);
  if (platform === 'coze') {
    await userEvent.type(screen.getByLabelText(/机器人标识/), 'bot-123');
    await userEvent.type(screen.getByLabelText(/平台基地址/), 'https://api.coze.cn');
  } else {
    await userEvent.type(screen.getByLabelText(/平台基地址/), 'https://dify.example.com/v1');
  }
  await userEvent.type(screen.getByLabelText('应用密钥'), 'test-pat');
}

async function startEdit(name: string) {
  renderPage();
  const row = (await screen.findByText(name)).closest('tr')!;
  await userEvent.click(within(row).getByRole('button', { name: '编辑' }));
  await screen.findByText('编辑评估对象');
}

const saveButton = () => screen.getByRole('button', { name: /^保存$/ });
const knowledgeInput = () => screen.getByLabelText('知识库暗号');
const systemInput = () => screen.getByLabelText('系统提示词暗号');
// create(payload) 与 update(id, payload) 的最后一个参数都是请求体。
const accessConfigOf = (call: unknown[]) =>
  (call.at(-1) as { accessConfig: Record<string, unknown> }).accessConfig;

describe('ModelTargetsPage 平台对象暗号', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.capabilities.mockResolvedValue({ platformAppEnabled: true });
    m.list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 });
    m.create.mockResolvedValue({ id: 'new', name: 'x' });
    m.update.mockResolvedValue({ id: 'platform-1', name: 'x' });
  });

  it('新建 Dify 对象：显示两个暗号输入框和说明，填写后随 accessConfig 提交，首尾空格被去掉', async () => {
    await startCreate('dify');
    expect(screen.getByText(/在测试应用的知识库蜜罐文档里放入同一个暗号；用于判断知识库越权。/)).toBeInTheDocument();
    expect(screen.getByText(/在测试应用的系统提示词里放入同一个暗号；用于判断系统提示词泄露。/)).toBeInTheDocument();
    expect(screen.getAllByText(/格式以 LSE-CANARY- 开头/)).toHaveLength(2);
    expect(knowledgeInput()).toHaveAttribute('placeholder', expect.stringContaining('LSE-CANARY-'));
    expect(screen.queryByText('已配置')).not.toBeInTheDocument();
    expect(screen.queryByText('未配置')).not.toBeInTheDocument();
    await userEvent.type(knowledgeInput(), 'LSE-CANARY-KB_1');
    await userEvent.type(systemInput(), ' LSE-CANARY-SYS-1 ');
    await userEvent.click(saveButton());
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(accessConfigOf(m.create.mock.calls[0]!)).toEqual({
      platform: 'dify',
      baseUrl: 'https://dify.example.com/v1',
      appMode: 'agent-chat',
      knowledgeCanary: 'LSE-CANARY-KB_1',
      systemCanary: 'LSE-CANARY-SYS-1',
    });
  });

  it('新建扣子对象：只填知识库暗号时，payload 只带这一个暗号', async () => {
    await startCreate('coze');
    await userEvent.type(knowledgeInput(), 'LSE-CANARY-KB_2');
    await userEvent.click(saveButton());
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(accessConfigOf(m.create.mock.calls[0]!)).toEqual({
      platform: 'coze',
      baseUrl: 'https://api.coze.cn',
      botId: 'bot-123',
      knowledgeCanary: 'LSE-CANARY-KB_2',
    });
  });

  it('新建时两个暗号都不填：payload 里没有这两个字段', async () => {
    await startCreate('coze');
    await userEvent.click(saveButton());
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    const accessConfig = accessConfigOf(m.create.mock.calls[0]!);
    expect(accessConfig).not.toHaveProperty('knowledgeCanary');
    expect(accessConfig).not.toHaveProperty('systemCanary');
  });

  it('编辑扣子对象留空：输入框为空，显示已配置/未配置，脱敏值不外露，保存时不带暗号字段', async () => {
    m.list.mockResolvedValue({ items: [cozeTarget()], total: 1 });
    await startEdit('扣子客服');
    expect(knowledgeInput()).toHaveValue('');
    expect(systemInput()).toHaveValue('');
    expect(knowledgeInput()).toHaveAccessibleDescription('已配置');
    expect(systemInput()).toHaveAccessibleDescription('未配置');
    expect(document.body.textContent).not.toContain('hash:');
    expect(document.body.textContent).not.toContain(MASKED_KNOWLEDGE);
    await userEvent.click(saveButton());
    await waitFor(() => expect(m.update).toHaveBeenCalledTimes(1));
    expect(m.update.mock.calls[0]![0]).toBe('platform-1');
    const accessConfig = accessConfigOf(m.update.mock.calls[0]!);
    expect(accessConfig).not.toHaveProperty('knowledgeCanary');
    expect(accessConfig).not.toHaveProperty('systemCanary');
    expect(JSON.stringify(m.update.mock.calls[0])).not.toContain('hash:');
    expect(accessConfig).toEqual({
      platform: 'coze',
      baseUrl: 'https://api.coze.cn',
      botId: 'bot-123',
      user: 'eval-user',
    });
  });

  it('编辑 Dify 对象并填入新暗号：只提交填写的字段，已有的 user 和 inputs 沿用', async () => {
    m.list.mockResolvedValue({ items: [difyTarget()], total: 1 });
    await startEdit('Dify 客服');
    expect(knowledgeInput()).toHaveAccessibleDescription('未配置');
    expect(systemInput()).toHaveAccessibleDescription('已配置');
    await userEvent.type(systemInput(), 'LSE-CANARY-SYS-NEW');
    await userEvent.click(saveButton());
    await waitFor(() => expect(m.update).toHaveBeenCalledTimes(1));
    const accessConfig = accessConfigOf(m.update.mock.calls[0]!);
    expect(accessConfig).toEqual({
      platform: 'dify',
      baseUrl: 'https://dify.example.com/v1',
      appMode: 'chat',
      user: 'eval-user',
      inputs: { region: 'cn' },
      systemCanary: 'LSE-CANARY-SYS-NEW',
    });
    expect(accessConfig).not.toHaveProperty('knowledgeCanary');
  });

  it('格式不合法时不能保存也不能连接诊断，并提示；改成合法值后可保存', async () => {
    m.list.mockResolvedValue({ items: [cozeTarget()], total: 1 });
    await startEdit('扣子客服');
    for (const bad of ['canary-abc', 'LSE-CANARY-', 'LSE-CANARY-含中文', 'LSE-CANARY-a b', MASKED_KNOWLEDGE]) {
      fireEvent.change(knowledgeInput(), { target: { value: bad } });
      expect(await screen.findByText(/暗号格式应为 LSE-CANARY- 开头/)).toBeInTheDocument();
      expect(knowledgeInput()).toHaveAttribute('aria-invalid', 'true');
      expect(saveButton()).toBeDisabled();
      expect(screen.getByRole('button', { name: '连接诊断' })).toBeDisabled();
    }
    await userEvent.click(saveButton());
    expect(m.update).not.toHaveBeenCalled();
    fireEvent.change(knowledgeInput(), { target: { value: 'LSE-CANARY-OK_1' } });
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(screen.queryByText(/暗号格式应为/)).not.toBeInTheDocument();
    await userEvent.click(saveButton());
    await waitFor(() => expect(m.update).toHaveBeenCalledTimes(1));
    expect(accessConfigOf(m.update.mock.calls[0]!).knowledgeCanary).toBe('LSE-CANARY-OK_1');
  });

  it('长度上限 128：128 个字符可以保存，129 个字符不行；系统提示词暗号同样校验', async () => {
    await startCreate('dify');
    const exactly128 = `LSE-CANARY-${'a'.repeat(117)}`;
    fireEvent.change(systemInput(), { target: { value: `${exactly128}b` } });
    expect(await screen.findByText(/暗号格式应为/)).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    fireEvent.change(systemInput(), { target: { value: exactly128 } });
    await waitFor(() => expect(saveButton()).toBeEnabled());
    await userEvent.click(saveButton());
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(accessConfigOf(m.create.mock.calls[0]!).systemCanary).toBe(exactly128);
  });
});
