import type { ComponentProps } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components/ui/toast';
import { ChangePasswordModal } from './ChangePasswordModal';

const apiMock = vi.hoisted(() => ({ changeMyPassword: vi.fn(), passwordPolicy: vi.fn() }));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { changeMyPassword: apiMock.changeMyPassword, passwordPolicy: apiMock.passwordPolicy },
}));

function renderModal(props: Partial<ComponentProps<typeof ChangePasswordModal>> = {}) {
  const onClose = vi.fn();
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  const { container } = render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <ChangePasswordModal open onClose={onClose} {...props} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  const [current, next, confirm] = Array.from(
    container.querySelectorAll<HTMLInputElement>('input[type="password"]'),
  ) as [HTMLInputElement, HTMLInputElement, HTMLInputElement];
  const submit = screen.getByRole('button', { name: '确认修改' });
  return { onClose, current, next, confirm, submit, invalidate };
}

describe('ChangePasswordModal', () => {
  beforeEach(() => {
    apiMock.changeMyPassword.mockReset();
    apiMock.passwordPolicy.mockReset();
    apiMock.passwordPolicy.mockResolvedValue({
      passwordMinLength: 8,
      passwordRequireUppercase: false,
      passwordRequireLowercase: false,
      passwordRequireDigit: false,
      passwordRequireSpecial: false,
      passwordExpireDays: 0,
    });
  });

  it('按安全设置动态展示密码长度与强度要求，不满足时不可提交', async () => {
    apiMock.passwordPolicy.mockResolvedValue({
      passwordMinLength: 12,
      passwordRequireUppercase: true,
      passwordRequireLowercase: false,
      passwordRequireDigit: true,
      passwordRequireSpecial: true,
      passwordExpireDays: 90,
    });
    const user = userEvent.setup();
    const { current, next, confirm, submit } = renderModal();
    expect(await screen.findByText('长度至少 12 位')).toBeInTheDocument();
    expect(screen.getByText('包含大写字母')).toBeInTheDocument();
    expect(screen.getByText('包含数字')).toBeInTheDocument();
    expect(screen.getByText('包含特殊字符')).toBeInTheDocument();
    await user.type(current, 'OldPass@1');
    await user.type(next, 'newpassword12');
    await user.type(confirm, 'newpassword12');
    expect(submit).toBeDisabled();
    await user.clear(next);
    await user.clear(confirm);
    await user.type(next, 'NewPassword@12');
    await user.type(confirm, 'NewPassword@12');
    expect(submit).toBeEnabled();
  });

  it('展示当前/新/确认三个密码输入框，初始时确认按钮禁用', () => {
    const { current, next, confirm, submit } = renderModal();
    expect(current).toBeInTheDocument();
    expect(next).toBeInTheDocument();
    expect(confirm).toBeInTheDocument();
    expect(screen.getByText('确认新密码')).toBeInTheDocument();
    expect(submit).toBeDisabled();
  });

  it('两次输入不一致时报错且不可提交', async () => {
    const user = userEvent.setup();
    const { current, next, confirm, submit } = renderModal();
    await user.type(current, 'OldPass@1');
    await user.type(next, 'NewPass@123');
    await user.type(confirm, 'NewPass@999');
    expect(screen.getByText('两次输入的密码不一致')).toBeInTheDocument();
    expect(submit).toBeDisabled();
  });

  it('新密码与当前密码相同时报错且不可提交', async () => {
    const user = userEvent.setup();
    const { current, next, confirm, submit } = renderModal();
    await user.type(current, 'SamePass@1');
    await user.type(next, 'SamePass@1');
    await user.type(confirm, 'SamePass@1');
    expect(screen.getByText('新密码不能与当前密码相同')).toBeInTheDocument();
    expect(submit).toBeDisabled();
  });

  it('两次一致且合法时提交，调用接口并关闭弹窗', async () => {
    apiMock.changeMyPassword.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    const { current, next, confirm, submit, onClose } = renderModal();
    await user.type(current, 'OldPass@1');
    await user.type(next, 'NewPass@123');
    await user.type(confirm, 'NewPass@123');
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() => {
      expect(apiMock.changeMyPassword).toHaveBeenCalledWith({
        currentPassword: 'OldPass@1',
        newPassword: 'NewPass@123',
      });
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
  it('「至少 N 位」只出现一处（强度清单里），输入过短时也不再重复报错', async () => {
    const user = userEvent.setup();
    const { next } = renderModal();
    expect(await screen.findByText('长度至少 8 位')).toBeInTheDocument();
    expect(screen.getAllByText(/至少 8 位/)).toHaveLength(1);
    await user.type(next, 'abc');
    expect(screen.getAllByText(/至少 8 位/)).toHaveLength(1);
    expect(screen.queryByText('新密码至少 8 位')).not.toBeInTheDocument();
  });

  it('首次登录强制改密：只有标题，不加说明句；不能取消', () => {
    renderModal({ forced: true, reason: 'first-login' });
    expect(screen.getByRole('dialog', { name: '首次登录请修改密码' })).toBeInTheDocument();
    expect(screen.queryByText(/方可继续使用平台/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '取消' })).not.toBeInTheDocument();
  });

  it('强制改密时给了 onLogout 就在底部显示「退出登录」', async () => {
    const onLogout = vi.fn();
    const user = userEvent.setup();
    renderModal({ forced: true, reason: 'first-login', onLogout });
    await user.click(screen.getByRole('button', { name: '退出登录' }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it('强制改密成功后让查询缓存整体失效，之前被拦下的数据重新拉取', async () => {
    apiMock.changeMyPassword.mockResolvedValue({ ok: true });
    const onChanged = vi.fn();
    const user = userEvent.setup();
    const { current, next, confirm, submit, invalidate } = renderModal({
      forced: true,
      reason: 'first-login',
      onChanged,
    });
    await user.type(current, 'OldPass@1');
    await user.type(next, 'NewPass@123');
    await user.type(confirm, 'NewPass@123');
    await user.click(submit);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(invalidate).toHaveBeenCalledWith();
  });

  it('弹窗带对话框语义，并以标题命名', () => {
    renderModal();
    expect(screen.getByRole('dialog', { name: '修改密码' })).toHaveAttribute('aria-modal', 'true');
  });
});
