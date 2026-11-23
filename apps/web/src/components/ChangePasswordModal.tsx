import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { DEFAULT_PASSWORD_POLICY, passwordRules, passwordSatisfies } from '@/lib/password-policy';
import { PasswordRuleList } from '@/components/PasswordRuleList';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';

/**
 * 当前登录用户自助修改自己的密码：当前密码 + 新密码 + 确认新密码（两次输入比对）。
 * 密码长度、强度要求取自「安全设置」，动态展示规则。forced=true 用于密码到期强制改密（不可关闭）。
 */
export function ChangePasswordModal({
  open,
  onClose,
  forced = false,
  reason = 'expired',
  onChanged,
  onLogout,
}: {
  open: boolean;
  onClose: () => void;
  forced?: boolean;
  /** 强制改密的原因：密码到期，或首次登录。 */
  reason?: 'expired' | 'first-login';
  onChanged?: () => void;
  /** 强制改密时给出「退出登录」（不想改就换个账号）。 */
  onLogout?: () => void;
}) {
  const { success, error: toastError } = useToast();
  const queryClient = useQueryClient();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const policyQuery = useQuery({
    queryKey: ['auth', 'password-policy'],
    queryFn: () => api.passwordPolicy(),
    enabled: open,
  });
  const policy = policyQuery.data ?? DEFAULT_PASSWORD_POLICY;
  const rules = passwordRules(newPassword, policy);

  function reset() {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
  }

  function close() {
    if (forced) return;
    reset();
    onClose();
  }

  const mutation = useMutation({
    mutationFn: () => api.changeMyPassword({ currentPassword, newPassword }),
    onSuccess: () => {
      success('密码已修改，请牢记新密码');
      reset();
      // 强制改密前被拦下（403）的查询都缓存了错误，改完整体失效重新拉取。
      if (forced) void queryClient.invalidateQueries();
      onChanged?.();
      onClose();
    },
    onError: (e) => toastError(e instanceof ApiError ? e.message : '修改失败'),
  });

  const valid = passwordSatisfies(newPassword, policy);
  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const sameAsOld = valid && newPassword === currentPassword;
  const canSubmit =
    !mutation.isPending &&
    currentPassword.length > 0 &&
    valid &&
    newPassword === confirmPassword &&
    !sameAsOld;

  return (
    <Modal
      open={open}
      onClose={close}
      title={
        !forced
          ? '修改密码'
          : reason === 'first-login'
            ? '首次登录请修改密码'
            : '密码已到期，请修改密码'
      }
      description={
        !forced
          ? '为保障账号安全，修改密码需先验证当前密码。'
          : reason === 'first-login'
            ? undefined
            : `已超过密码强制更新时间（${policy.passwordExpireDays} 天），修改密码后方可继续使用平台。`
      }
      footer={
        <>
          {!forced && (
            <Button variant="ghost" onClick={close}>
              取消
            </Button>
          )}
          {forced && onLogout && (
            <Button variant="ghost" className="mr-auto" onClick={onLogout}>
              退出登录
            </Button>
          )}
          <Button onClick={() => mutation.mutate()} disabled={!canSubmit}>
            确认修改
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="当前密码" required>
          <Input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder="请输入当前登录密码"
          />
        </Field>
        <Field label="新密码" required error={sameAsOld ? '新密码不能与当前密码相同' : undefined}>
          <Input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </Field>
        <PasswordRuleList rules={rules} />
        <Field label="确认新密码" required error={mismatch ? '两次输入的密码不一致' : undefined}>
          <Input
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="请再次输入新密码"
          />
        </Field>
      </div>
    </Modal>
  );
}
