import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from './LoginPage';

const loginMock = vi.hoisted(() => vi.fn());
const loginStatsMock = vi.hoisted(() => vi.fn());
const recordVisitMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { loginStats: loginStatsMock, recordVisit: recordVisitMock },
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ login: loginMock }),
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );
}

describe('LoginPage', () => {
  beforeEach(() => {
    loginMock.mockReset();
    loginStatsMock.mockReset();
    recordVisitMock.mockReset();
    recordVisitMock.mockResolvedValue(undefined);
    loginStatsMock.mockResolvedValue({
      registrationEnabled: false,
      visits: { today: 0, total: 0 },
      downloads: { today: 0, total: 0 },
    });
  });

  it('打开页面计一次访问，底部显示今日和累计的访问量、下载量', async () => {
    loginStatsMock.mockResolvedValue({
      registrationEnabled: false,
      visits: { today: 3, total: 1200 },
      downloads: { today: 1, total: 56 },
    });
    renderPage();

    expect(await screen.findByText('今日访问 3 · 累计 1,200')).toBeInTheDocument();
    expect(screen.getByText('今日下载 1 · 累计 56')).toBeInTheDocument();
    expect(recordVisitMock).toHaveBeenCalledTimes(1);
  });

  it('统计接口不可用时不显示统计，也不影响登录', async () => {
    recordVisitMock.mockRejectedValue(new Error('down'));
    loginStatsMock.mockRejectedValue(new Error('down'));
    renderPage();

    await waitFor(() => expect(loginStatsMock).toHaveBeenCalled());
    expect(screen.queryByText(/今日访问/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '登录' })).toBeEnabled();
  });

  it('未开放注册时看不到注册入口', async () => {
    renderPage();

    await waitFor(() => expect(loginStatsMock).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: '注册' })).not.toBeInTheDocument();
  });

  it('开放注册时显示注册入口，指向注册页', async () => {
    loginStatsMock.mockResolvedValue({
      registrationEnabled: true,
      visits: { today: 0, total: 0 },
      downloads: { today: 0, total: 0 },
    });
    renderPage();

    const link = await screen.findByRole('link', { name: '注册' });
    expect(link).toHaveAttribute('href', '/register');
  });

  it('展示登录入口，不暴露任何内置账号信息', () => {
    renderPage();

    expect(screen.getByRole('heading', { name: '鉴盾' })).toBeInTheDocument();
    expect(screen.queryByText('管理员账号：admin')).not.toBeInTheDocument();
    expect(screen.queryByText('默认管理员：admin')).not.toBeInTheDocument();
    expect(screen.queryByText('HTTPS 安全登录')).not.toBeInTheDocument();
    expect(screen.queryByText(/TLS 加密/)).not.toBeInTheDocument();
  });

  it('用户名框不预填内置管理员账号名', () => {
    renderPage();

    const username = screen.getByLabelText('用户名');
    expect(username).toHaveValue('');
    expect(screen.queryByDisplayValue('admin')).not.toBeInTheDocument();
  });

  it('不再常驻「首次登录请使用交付文档中的管理员凭据」，改为不点名账号的中性说明', () => {
    renderPage();

    expect(screen.queryByText(/交付文档/)).not.toBeInTheDocument();
    expect(screen.queryByText(/管理员凭据/)).not.toBeInTheDocument();
    expect(
      screen.getByText('账号由平台管理员分配；忘记账号或密码，请联系平台管理员。'),
    ).toBeInTheDocument();
  });

  it('产品卖点用统一术语：评估而非评测，AI 组件漏洞扫描带空格', () => {
    renderPage();

    expect(screen.getByText('内容安全评估')).toBeInTheDocument();
    expect(screen.getByText('多轮对抗演练')).toBeInTheDocument();
    expect(screen.getByText('AI 组件漏洞扫描')).toBeInTheDocument();
    expect(screen.queryByText(/评测/)).not.toBeInTheDocument();
  });

  it('输入账号密码后提交，用户名会去掉首尾空格', async () => {
    loginMock.mockResolvedValue({});
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('用户名'), '  zhangsan ');
    await user.type(screen.getByLabelText('密码'), 'Secret#123');
    await user.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(loginMock).toHaveBeenCalledWith('zhangsan', 'Secret#123'));
  });

  it('没填用户名时不能提交', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('密码'), 'Secret#123');
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(loginMock).not.toHaveBeenCalled();
  });
});
