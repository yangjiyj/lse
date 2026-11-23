import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import { ModelTargetsPage } from './ModelTargetsPage';

const m = vi.hoisted(() => ({
  list: vi.fn(),
  fpList: vi.fn(),
  perms: new Set<string>(),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    modelTargets: {
      list: m.list,
      create: vi.fn(),
      update: vi.fn(),
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
  modelFingerprintApi: {
    list: m.fpList,
    collect: vi.fn(),
    setBaseline: vi.fn(),
    compare: vi.fn(),
  },
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: (code: string) => m.perms.has(code) }),
}));

const target = (id: string, name: string, targetType: string) => ({
  id,
  name,
  targetType,
  provider: 'openai-compatible-local',
  model: 'qwen2.5',
  baseUrl: 'http://127.0.0.1:8000/v1',
  apiKeyMasked: null,
  hasApiKey: false,
  extraHeaders: null,
  defaultParams: null,
  accessConfig: null,
  isGlobal: false,
  isActive: true,
  lastTestStatus: null,
  lastTestedAt: null,
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z',
  createdBy: null,
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

function rowOf(name: string) {
  return screen.getAllByText(name)[0]!.closest('tr')!;
}

describe('ModelTargetsPage 模型指纹入口', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.perms = new Set(['model_target:read', 'model_target:update']);
    m.list.mockResolvedValue({
      items: [
        target('t-model', '对象甲', 'MODEL'),
        target('t-agent', '对象乙', 'AGENT_API'),
        target('t-public', '对象丙', 'PUBLIC_AGENT'),
        target('t-log', '对象丁', 'GATEWAY_LOG'),
      ],
      total: 4,
      page: 1,
      pageSize: 10,
    });
    m.fpList.mockResolvedValue({
      items: [],
      baselineId: null,
      probeVersion: 'v1',
      probes: [],
      defaultThreshold: 0.6,
    });
  });

  it('仅模型/智能体类对象显示“模型指纹”链接，点击打开弹窗', async () => {
    renderPage();
    await screen.findAllByText('对象甲');
    for (const name of ['对象甲', '对象乙', '对象丙']) {
      expect(within(rowOf(name)).getByRole('button', { name: '模型指纹' })).toBeInTheDocument();
    }
    expect(within(rowOf('对象丁')).queryByRole('button', { name: '模型指纹' })).toBeNull();

    await userEvent.click(within(rowOf('对象甲')).getByRole('button', { name: '模型指纹' }));
    expect(await screen.findByText('尚未设置基线，任务执行前不会比对')).toBeInTheDocument();
    expect(m.fpList).toHaveBeenCalledWith('t-model', 20);
    expect(screen.getByRole('button', { name: '采集指纹' })).toBeInTheDocument();
  });

  it('无 update 权限时弹窗只读，不显示采集按钮', async () => {
    m.perms = new Set(['model_target:read']);
    renderPage();
    await screen.findAllByText('对象甲');
    await userEvent.click(within(rowOf('对象甲')).getByRole('button', { name: '模型指纹' }));
    expect(await screen.findByText('平台内部指纹比对，非模型身份认证结论')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '采集指纹' })).not.toBeInTheDocument();
  });
});
