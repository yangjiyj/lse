import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RegisterPage } from './RegisterPage';

const registerMock = vi.hoisted(() => vi.fn());
const loginStatsMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    issues?: unknown;
    constructor(message: string, issues?: unknown) {
      super(message);
      this.issues = issues;
    }
  }
  return { ApiError, api: { register: registerMock, loginStats: loginStatsMock } };
});

function stats(overrides: Record<string, unknown> = {}) {
  return {
    registrationEnabled: true,
    visits: { today: 0, total: 0 },
    downloads: { today: 0, total: 0 },
    passwordPolicy: {
      passwordMinLength: 8,
      passwordRequireUppercase: false,
      passwordRequireLowercase: false,
      passwordRequireDigit: false,
      passwordRequireSpecial: false,
    },
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <RegisterPage />
    </MemoryRouter>,
  );
}

async function fillForm(confirm = 'Register@123', password = 'Register@123') {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText(/用户名/), 'zhangsan');
  await user.type(screen.getByLabelText(/姓名/), '张三');
  await user.type(screen.getByLabelText(/手机号/), '13800138000');
  await user.type(screen.getByLabelText(/单位/), '测试单位');
  await user.type(screen.getByLabelText(/^密码/, { selector: 'input' }), password);
  await user.type(screen.getByLabelText(/确认密码/), confirm);
  return user;
}

describe('RegisterPage', () => {
  beforeEach(() => {
    registerMock.mockReset();
    loginStatsMock.mockReset();
    loginStatsMock.mockResolvedValue(stats());
  });

  it('未开放注册时直接显示「未开放注册」，不显示表单', async () => {
    loginStatsMock.mockResolvedValue(stats({ registrationEnabled: false, passwordPolicy: null }));
    renderPage();
    expect(await screen.findByText('未开放注册')).toBeInTheDocument();
    expect(screen.queryByLabelText(/用户名/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '注册' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '返回登录' })).toHaveAttribute('href', '/login');
  });

  it('按安全设置显示密码规则，不满足时不能提交', async () => {
    loginStatsMock.mockResolvedValue(
      stats({
        passwordPolicy: {
          passwordMinLength: 12,
          passwordRequireUppercase: true,
          passwordRequireLowercase: false,
          passwordRequireDigit: true,
          passwordRequireSpecial: false,
        },
      }),
    );
    renderPage();
    expect(await screen.findByText('长度至少 12 位')).toBeInTheDocument();
    expect(screen.getByText('包含大写字母')).toBeInTheDocument();
    expect(screen.getByText('包含数字')).toBeInTheDocument();
    expect(screen.queryByText('包含特殊字符')).not.toBeInTheDocument();

    const user = await fillForm('register1234', 'register1234');
    expect(screen.getByRole('button', { name: '注册' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '注册' }));
    expect(registerMock).not.toHaveBeenCalled();
  });

  it('提交成功后显示等待审核', async () => {
    registerMock.mockResolvedValue({ ok: true });
    renderPage();

    const user = await fillForm();
    await user.click(screen.getByRole('button', { name: '注册' }));

    await waitFor(() =>
      expect(registerMock).toHaveBeenCalledWith({
        username: 'zhangsan',
        displayName: '张三',
        phone: '13800138000',
        organization: '测试单位',
        password: 'Register@123',
      }),
    );
    expect(await screen.findByText('已提交，等待管理员审核')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '返回登录' })).toHaveAttribute('href', '/login');
  });

  it('两次密码不一致时不提交', async () => {
    renderPage();

    const user = await fillForm('Other@1234');
    await user.click(screen.getByRole('button', { name: '注册' }));

    expect(screen.getByText('两次输入的密码不一致')).toBeInTheDocument();
    expect(registerMock).not.toHaveBeenCalled();
  });

  it('服务端校验失败时显示具体原因', async () => {
    const { ApiError } = await import('@/lib/api');
    registerMock.mockRejectedValue(
      new (ApiError as unknown as new (m: string, i: unknown) => Error)('参数校验失败', [
        { message: '手机号格式不正确' },
      ]),
    );
    renderPage();

    const user = await fillForm();
    await user.click(screen.getByRole('button', { name: '注册' }));

    expect(await screen.findByText('手机号格式不正确')).toBeInTheDocument();
  });
});
