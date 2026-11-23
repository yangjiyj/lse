import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save, ShieldCheck } from 'lucide-react';
import { api, ApiError, type SecuritySettings, type SystemSettings } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/components/ui/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { LoadingBlock, Spinner } from '@/components/ui/spinner';
import { formatDateTime } from '@/lib/format';

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = {
  passwordMinLength: 8,
  passwordRequireUppercase: false,
  passwordRequireLowercase: false,
  passwordRequireDigit: false,
  passwordRequireSpecial: false,
  passwordExpireDays: 0,
  maxFailedLoginAttempts: 5,
  lockoutMinutes: 15,
  idleTimeoutMinutes: 30,
  auditLogAccess: 'admins_and_auditors',
  forcePasswordChangeOnFirstLogin: true,
  registrationEnabled: false,
  registrationTenantId: null,
};

const AUDIT_LOG_ACCESS_OPTIONS: Array<{
  value: SecuritySettings['auditLogAccess'];
  label: string;
}> = [
  { value: 'admins_and_auditors', label: '管理员和审计员' },
  { value: 'system_admin_only', label: '仅平台管理员' },
];

type NumberKey =
  | 'passwordMinLength'
  | 'passwordExpireDays'
  | 'maxFailedLoginAttempts'
  | 'lockoutMinutes'
  | 'idleTimeoutMinutes';
type BoolKey =
  | 'passwordRequireUppercase'
  | 'passwordRequireLowercase'
  | 'passwordRequireDigit'
  | 'passwordRequireSpecial';

const NUMBER_FIELDS: Array<{
  key: NumberKey;
  label: string;
  unit: string;
  min: number;
  max: number;
  hint: string;
}> = [
  {
    key: 'passwordMinLength',
    label: '密码长度',
    unit: '位',
    min: 6,
    max: 64,
    hint: '新建、重置、修改密码时的最小长度',
  },
  {
    key: 'passwordExpireDays',
    label: '密码强制更新时间',
    unit: '天',
    min: 0,
    max: 3650,
    hint: '超过天数后登录须先改密；0 表示不强制',
  },
  {
    key: 'maxFailedLoginAttempts',
    label: '最大非法登录次数',
    unit: '次',
    min: 0,
    max: 100,
    hint: '连续输错达到次数即禁用账户；0 表示不限制',
  },
  {
    key: 'lockoutMinutes',
    label: '超过最大次数后禁用账户时间',
    unit: '分钟',
    min: 1,
    max: 1440,
    hint: '禁用期间正确密码也无法登录',
  },
  {
    key: 'idleTimeoutMinutes',
    label: '超时登出时间',
    unit: '分钟',
    min: 0,
    max: 1440,
    hint: '无操作超过该时间自动登出；0 表示不限制',
  },
];

const STRENGTH_FIELDS: Array<{ key: BoolKey; label: string }> = [
  { key: 'passwordRequireUppercase', label: '包含大写字母' },
  { key: 'passwordRequireLowercase', label: '包含小写字母' },
  { key: 'passwordRequireDigit', label: '包含数字' },
  { key: 'passwordRequireSpecial', label: '包含特殊字符' },
];

/** 平台设置 →「安全设置」：密码长度、强度要求，密码强制更新时间，最大非法登录次数，禁用账户时间，超时登出时间。 */
export function SecuritySettingsCard({ canUpdate }: { canUpdate: boolean }) {
  const { success, error: toastError } = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['system-settings'],
    queryFn: () => api.systemSettings.get(),
  });
  const [form, setForm] = useState<SecuritySettings>(DEFAULT_SECURITY_SETTINGS);
  const [tenantError, setTenantError] = useState<string | null>(null);
  // 租户列表只有平台管理员能读；读不到时不显示归属租户，由后端按平台租户处理。
  const canPickTenant = Boolean(useAuth().user?.isPlatformAdmin);
  const tenantsQuery = useQuery({
    queryKey: ['tenants'],
    queryFn: () => api.tenants.list(),
    enabled: canPickTenant && form.registrationEnabled,
  });
  const tenantOptions = (tenantsQuery.data?.items ?? []).filter(
    (t) => t.isActive || t.id === form.registrationTenantId,
  );

  useEffect(() => {
    if (query.data?.security) setForm(query.data.security);
  }, [query.data]);

  const save = useMutation({
    mutationFn: () => api.systemSettings.update({ security: form }),
    onSuccess: (res: SystemSettings) => {
      queryClient.setQueryData(['system-settings'], res);
      if (res.security) setForm(res.security);
      success('安全设置已保存');
    },
    onError: (e) => toastError(e instanceof ApiError ? e.message : '保存失败'),
  });

  function submit() {
    if (canPickTenant && form.registrationEnabled && !form.registrationTenantId) {
      setTenantError('请选择注册用户归属租户');
      return;
    }
    save.mutate();
  }

  if (query.isLoading) return <LoadingBlock label="正在加载安全设置…" />;

  const updatedAt = query.data?.updatedAt.security;
  return (
    <Card id="security-settings" className="scroll-mt-5 rounded-none border-0 shadow-none">
      <CardHeader className="border-b border-line pb-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
          <CardTitle>安全设置</CardTitle>
          <Badge tone="success">已启用</Badge>
        </div>
        <p className="text-sm text-ink-3">
          支持配置用户的密码长度、强度要求，密码强制更新时间，最大非法登录次数，超过最大次数后禁用账户时间，超时登出时间。
        </p>
      </CardHeader>
      <CardContent className="space-y-5 pt-5">
        {!canUpdate ? (
          <div className="rounded-md border border-amber-200 bg-severity-medium-bg px-3 py-2 text-sm text-severity-medium">
            当前账号没有权限修改安全设置，以下为只读展示。
          </div>
        ) : null}
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-ink">密码强度要求</legend>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {STRENGTH_FIELDS.map((f) => (
              <label key={f.key} className="flex items-center gap-2 text-sm text-ink-2">
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0 accent-primary"
                  checked={form[f.key]}
                  onChange={(e) => setForm({ ...form, [f.key]: e.target.checked })}
                  disabled={!canUpdate}
                />
                {f.label}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input
              type="checkbox"
              className="h-4 w-4 shrink-0 accent-primary"
              checked={form.forcePasswordChangeOnFirstLogin}
              onChange={(e) =>
                setForm({ ...form, forcePasswordChangeOnFirstLogin: e.target.checked })
              }
              disabled={!canUpdate}
            />
            首次登录强制改密
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input
              type="checkbox"
              className="h-4 w-4 shrink-0 accent-primary"
              checked={form.registrationEnabled}
              onChange={(e) => setForm({ ...form, registrationEnabled: e.target.checked })}
              disabled={!canUpdate}
            />
            开放注册
          </label>
        </div>
        {canPickTenant && form.registrationEnabled ? (
          <Field
            label="注册用户归属租户"
            htmlFor="security-registrationTenantId"
            error={tenantError ?? undefined}
            className="max-w-sm"
          >
            <Select
              id="security-registrationTenantId"
              value={form.registrationTenantId ?? ''}
              onChange={(e) => {
                setTenantError(null);
                setForm({ ...form, registrationTenantId: e.target.value || null });
              }}
              disabled={!canUpdate}
            >
              <option value="">请选择</option>
              {tenantOptions.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <div className="grid gap-4 md:grid-cols-2">
          {NUMBER_FIELDS.map((f) => (
            <Field
              key={f.key}
              label={`${f.label}（${f.unit}）`}
              htmlFor={`security-${f.key}`}
              hint={f.hint}
            >
              <Input
                id={`security-${f.key}`}
                type="number"
                min={f.min}
                max={f.max}
                value={form[f.key]}
                onChange={(e) => setForm({ ...form, [f.key]: Number(e.target.value) })}
                disabled={!canUpdate}
              />
            </Field>
          ))}
          <Field
            label="操作日志查看范围"
            htmlFor="security-auditLogAccess"
            hint="仅平台管理员时，审计员和租户管理员不能查看和导出"
          >
            <Select
              id="security-auditLogAccess"
              value={form.auditLogAccess}
              onChange={(e) =>
                setForm({
                  ...form,
                  auditLogAccess: e.target.value as SecuritySettings['auditLogAccess'],
                })
              }
              disabled={!canUpdate}
            >
              {AUDIT_LOG_ACCESS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <Button
            aria-label="保存安全设置"
            onClick={submit}
            disabled={!canUpdate || save.isPending}
          >
            {save.isPending ? <Spinner className="h-4 w-4" /> : <Save className="h-4 w-4" />}
            保存配置
          </Button>
          {updatedAt ? (
            <span className="text-xs text-ink-3">最近更新：{formatDateTime(updatedAt)}</span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
