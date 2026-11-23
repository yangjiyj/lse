import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import { isDeployActive, type RemoteDeploy } from '@/lib/remote-deploy';
import { RemoteDeployTab } from './RemoteDeployTab';

const mocks = vi.hoisted(() => ({
  capability: vi.fn(),
  hostKey: vi.fn(),
  startSsh: vi.fn(),
  createManual: vi.fn(),
  list: vi.fn(),
}));

vi.mock('@/lib/remote-deploy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/remote-deploy')>()),
  remoteDeployApi: {
    capability: mocks.capability,
    hostKey: mocks.hostKey,
    startSsh: mocks.startSsh,
    createManual: mocks.createManual,
    list: mocks.list,
  },
}));

const FP = 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';

function record(o: Partial<RemoteDeploy> = {}): RemoteDeploy {
  return {
    id: 'd1',
    mode: 'ssh',
    host: '10.0.0.8',
    port: 22,
    username: 'root',
    authType: 'password',
    hostKeyFingerprint: FP,
    hostKeyType: 'ssh-ed25519',
    status: 'SUCCEEDED',
    enableEval: false,
    runPosture: true,
    endpointId: 'ep1',
    endpointHref: '/fleet/endpoints/ep1',
    postureTaskId: 't1',
    postureTaskHref: '/eval-tasks/t1',
    startedAt: '2026-11-22T00:00:00.000Z',
    connectedAt: '2026-11-22T00:00:01.000Z',
    uploadedAt: '2026-11-22T00:00:03.000Z',
    scriptFetchedAt: null,
    installedAt: '2026-11-22T00:00:20.000Z',
    registeredAt: '2026-11-22T00:00:25.000Z',
    firstReportAt: '2026-11-22T00:00:31.000Z',
    durationMs: 25000,
    withinTarget: true,
    errorCode: null,
    errorMessage: null,
    log: null,
    createdAt: '2026-11-22T00:00:00.000Z',
    updatedAt: '2026-11-22T00:00:31.000Z',
    ...o,
  };
}

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <RemoteDeployTab />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const passwordInput = (form: HTMLElement) =>
  within(form).getByLabelText(/^口令/, { selector: 'input[type="password"]' });

async function fillSshForm(user: ReturnType<typeof userEvent.setup>) {
  const form = await screen.findByRole('region', { name: 'SSH 部署' });
  await user.type(within(form).getByLabelText(/^主机/), '10.0.0.8');
  await user.type(passwordInput(form), 'pw-for-test');
  await user.click(within(form).getByRole('button', { name: '获取主机指纹' }));
  expect(await within(form).findByText(FP)).toBeInTheDocument();
  return form;
}

describe('RemoteDeployTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.capability.mockResolvedValue({ ssh: true, missing: [], oneclick: true, reasons: [] });
    mocks.hostKey.mockResolvedValue({ type: 'ssh-ed25519', fingerprint: FP });
    mocks.startSsh.mockResolvedValue(record({ status: 'CONNECTING', durationMs: null }));
    mocks.list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 });
  });

  it('不勾「已核对指纹」时部署按钮置灰', async () => {
    const user = userEvent.setup();
    renderTab();
    const form = await fillSshForm(user);
    const deploy = within(form).getByRole('button', { name: '部署' });
    expect(deploy).toBeDisabled();
    await user.click(within(form).getByRole('checkbox', { name: '已核对指纹' }));
    expect(deploy).toBeEnabled();
    // 改了主机，指纹作废，要重新获取
    await user.type(within(form).getByLabelText(/^主机/), '9');
    expect(within(form).queryByText(FP)).not.toBeInTheDocument();
    expect(deploy).toBeDisabled();
  });

  it('口令、私钥口令、sudo 口令框都不让浏览器自动填充（new-password）', async () => {
    const user = userEvent.setup();
    renderTab();
    const form = await screen.findByRole('region', { name: 'SSH 部署' });
    await user.clear(within(form).getByLabelText(/^用户名/));
    await user.type(within(form).getByLabelText(/^用户名/), 'deploy');
    expect(passwordInput(form)).toHaveAttribute('autocomplete', 'new-password');
    expect(within(form).getByLabelText(/^sudo 口令/)).toHaveAttribute(
      'autocomplete',
      'new-password',
    );
  });

  it('提交后口令输入框被清空，请求带核对过的指纹', async () => {
    const user = userEvent.setup();
    renderTab();
    const form = await fillSshForm(user);
    await user.click(within(form).getByRole('checkbox', { name: '已核对指纹' }));
    await user.click(within(form).getByRole('button', { name: '部署' }));
    await waitFor(() => expect(mocks.startSsh).toHaveBeenCalledTimes(1));
    expect(mocks.startSsh).toHaveBeenCalledWith({
      host: '10.0.0.8',
      port: 22,
      username: 'root',
      auth: { type: 'password', password: 'pw-for-test' },
      hostKeyFingerprint: FP,
      hostKeyType: 'ssh-ed25519',
      enableEval: false,
      runPosture: true,
    });
    expect(passwordInput(form)).toHaveValue('');
  });

  it('capability.ssh = false 时不显示 SSH 表单，只有一次性部署命令', async () => {
    const user = userEvent.setup();
    mocks.capability.mockResolvedValue({
      ssh: false,
      missing: ['ssh', 'ssh-keyscan'],
      oneclick: true,
      reasons: [],
    });
    mocks.createManual.mockResolvedValue({
      item: record({ mode: 'manual', status: 'PENDING' }),
      command: 'curl -fsSL https://lse.example/api/fleet/install/linux.sh | sudo bash',
    });
    renderTab();
    expect(
      await screen.findByText('平台未安装 SSH 客户端，只能使用一次性部署命令'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'SSH 部署' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '获取主机指纹' })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/^主机/), '10.0.0.9');
    await user.click(screen.getByRole('button', { name: '生成部署命令' }));
    expect(await screen.findByLabelText('部署命令')).toHaveTextContent('linux.sh');
    expect(mocks.createManual).toHaveBeenCalledWith({
      host: '10.0.0.9',
      enableEval: false,
      runPosture: true,
    });
  });

  it('耗时 31000 显示为橙色并标「超过 30 秒」，30 秒内为绿色', async () => {
    mocks.list.mockResolvedValue({
      items: [
        record({ id: 'slow', host: '10.0.0.31', durationMs: 31000, withinTarget: false }),
        record({ id: 'fast', host: '10.0.0.25', durationMs: 25000 }),
      ],
      total: 2,
      page: 1,
      pageSize: 50,
    });
    renderTab();
    const slow = (await screen.findByText('10.0.0.31:22')).closest('tr')!;
    const slowDuration = within(slow).getByText('31.0 秒（超过 30 秒）');
    expect(slowDuration).toHaveClass('text-orange-600');
    expect(slowDuration).toHaveTextContent('超过 30 秒');
    const fast = screen.getByText('10.0.0.25:22').closest('tr')!;
    expect(within(fast).getByText('25.0 秒')).toHaveClass('text-emerald-600');
    expect(within(fast).getByRole('link', { name: '查看终端' })).toHaveAttribute(
      'href',
      '/fleet/endpoints/ep1',
    );
  });

  it('超时但终端已登记的记为完成并用橙色提示；过期没执行的一次性命令标「已过期」', async () => {
    mocks.list.mockResolvedValue({
      items: [
        record({
          id: 'slowreg',
          host: '10.0.0.40',
          status: 'SUCCEEDED',
          errorCode: 'TIMEOUT_REGISTERED',
          errorMessage: '部署超过 120 秒，安装脚本已中止，但终端已登记；请到终端详情确认探针状态',
        }),
        record({
          id: 'expired',
          mode: 'manual',
          host: '10.0.0.41',
          port: null,
          status: 'EXPIRED',
          durationMs: null,
          errorMessage: '一次性部署命令已过期，未在目标主机上执行',
        }),
      ],
      total: 2,
      page: 1,
      pageSize: 50,
    });
    renderTab();
    const slow = (await screen.findByText('10.0.0.40:22')).closest('tr')!;
    expect(within(slow).getByText('已完成')).toBeInTheDocument();
    expect(within(slow).getByText(/终端已登记/)).toHaveClass('text-severity-medium');
    const expired = screen.getByText('10.0.0.41').closest('tr')!;
    expect(within(expired).getByText('已过期')).toBeInTheDocument();
  });

  it('一键安装不可用时提示面向用户，不写环境变量名；口令框和主机框一样宽', async () => {
    mocks.capability.mockResolvedValue({
      ssh: true,
      missing: [],
      oneclick: false,
      reasons: ['部署信息尚未就绪（服务端地址或证书未配置完整）', '未配置探针包目录 FLEET_KIT_DIR'],
    });
    renderTab();
    expect(
      await screen.findByText('一键安装包还没配置好，暂时不能部署，请联系平台管理员'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/FLEET_KIT_DIR|证书/)).toBeNull();
    const form = screen.getByRole('region', { name: 'SSH 部署' });
    const field = (el: HTMLElement) => el.closest('div.lg\\:col-span-2');
    expect(field(within(form).getByLabelText(/^主机/))).not.toBeNull();
    expect(field(passwordInput(form))).not.toBeNull();
  });
});

describe('isDeployActive', () => {
  it('只有真正在进行中的才算：没人执行的一次性命令不算', () => {
    const base = { mode: 'manual' as const, status: 'PENDING' as const, scriptFetchedAt: null };
    expect(isDeployActive(base)).toBe(false);
    expect(isDeployActive({ ...base, scriptFetchedAt: '2026-11-22T00:00:00.000Z' })).toBe(true);
    expect(isDeployActive({ ...base, mode: 'ssh' })).toBe(true);
    expect(isDeployActive({ ...base, mode: 'ssh', status: 'INSTALLING' })).toBe(true);
    expect(isDeployActive({ ...base, status: 'EXPIRED' })).toBe(false);
  });
});
