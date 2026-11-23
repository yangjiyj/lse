import { useEffect, useState, type ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Save, Trash2, Upload } from 'lucide-react';
import { api, ApiError, type SystemSettings, type TenantSettings } from '@/lib/api';
import { DEFAULT_PLATFORM_TITLE, safeLogo, setBranding } from '@/lib/branding';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { LoadingBlock, Spinner } from '@/components/ui/spinner';
import { formatDateTime } from '@/lib/format';

export const LOGO_ACCEPT = 'image/png,image/jpeg,image/x-icon,image/vnd.microsoft.icon,image/webp';
export const LOGO_MAX_KB = 256;
const ALLOWED_EXT = /\.(png|jpe?g|ico|webp)$/i;

/** 前端预校验（后端按文件头再校验）：只允许 png/jpg/ico/webp，禁止 SVG，限制大小。 */
export function logoFileError(file: File): string | null {
  if (/svg/i.test(file.type) || /\.svg$/i.test(file.name)) return '不支持 SVG 格式';
  if (!ALLOWED_EXT.test(file.name)) return '仅支持 PNG/JPG/ICO/WEBP 格式';
  if (file.size > LOGO_MAX_KB * 1024) return `图片不能超过 ${LOGO_MAX_KB} KB`;
  return null;
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function LogoField({
  id,
  label,
  hint,
  value,
  disabled,
  onChange,
  onError,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
  onError: (msg: string) => void;
}) {
  const src = safeLogo(value);
  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const err = logoFileError(file);
    if (err) return onError(`${label}：${err}`);
    onChange(await readDataUrl(file));
  };
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <div className="flex items-center gap-3">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-canvas">
          {src ? (
            <img src={src} alt={`${label}预览`} className="h-full w-full object-contain" />
          ) : (
            <span className="text-xs text-ink-3">默认</span>
          )}
        </div>
        <label
          className={`inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md border border-line-2 bg-white px-3 text-sm text-ink-2 hover:bg-slate-100 ${disabled ? 'pointer-events-none opacity-50' : ''}`}
        >
          <Upload className="h-4 w-4" />
          上传
          <input
            id={id}
            aria-label={`上传${label}`}
            type="file"
            accept={LOGO_ACCEPT}
            className="sr-only"
            disabled={disabled}
            onChange={onFile}
          />
        </label>
        {src ? (
          <Button variant="ghost" size="sm" onClick={() => onChange('')} disabled={disabled}>
            <Trash2 className="h-4 w-4" />
            恢复默认
          </Button>
        ) : null}
      </div>
    </Field>
  );
}

const EMPTY_TENANT: TenantSettings = {
  platformTitle: DEFAULT_PLATFORM_TITLE,
  platformLogo: '',
  tabLogo: '',
  supportOrg: '',
  contactName: '',
  contactPhone: '',
  contactEmail: '',
};

const CONTACT_FIELDS: Array<{
  key: 'supportOrg' | 'contactName' | 'contactPhone' | 'contactEmail';
  label: string;
  maxLength: number;
  type?: string;
}> = [
  { key: 'supportOrg', label: '支持单位', maxLength: 100 },
  { key: 'contactName', label: '联系人', maxLength: 40 },
  { key: 'contactPhone', label: '联系电话', maxLength: 30, type: 'tel' },
  { key: 'contactEmail', label: '联系邮箱', maxLength: 100, type: 'email' },
];

/** 平台设置 →「平台品牌」：配置平台 logo、页签 logo、平台标题和技术支持联系方式（与「租户管理」不是一回事）。 */
export function TenantSettingsCard({ canUpdate }: { canUpdate: boolean }) {
  const { success, error: toastError } = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['system-settings'],
    queryFn: () => api.systemSettings.get(),
  });
  const [form, setForm] = useState<TenantSettings>(EMPTY_TENANT);

  useEffect(() => {
    if (query.data?.tenant) setForm({ ...EMPTY_TENANT, ...query.data.tenant });
  }, [query.data]);

  const save = useMutation({
    mutationFn: () => api.systemSettings.update({ tenant: form }),
    onSuccess: (res: SystemSettings) => {
      queryClient.setQueryData(['system-settings'], res);
      if (res.tenant) {
        setForm(res.tenant);
        setBranding(res.tenant);
      }
      success('平台品牌已保存，登录页、侧边栏与浏览器页签已生效');
    },
    onError: (e) => toastError(e instanceof ApiError ? e.message : '保存失败'),
  });

  if (query.isLoading) return <LoadingBlock label="正在加载平台品牌…" />;
  const updatedAt = query.data?.updatedAt.tenant;

  return (
    <Card id="tenant-settings" className="scroll-mt-5 rounded-none border-0 shadow-none">
      <CardHeader className="border-b border-line pb-4">
        <div className="flex items-center gap-2">
          <Building2 className="h-5 w-5 text-primary" />
          <CardTitle>平台品牌</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 pt-5">
        {!canUpdate ? (
          <div className="rounded-md border border-amber-200 bg-severity-medium-bg px-3 py-2 text-sm text-severity-medium">
            当前账号没有权限修改平台品牌，以下为只读展示。
          </div>
        ) : null}
        <Field
          label="平台标题"
          htmlFor="tenant-platform-title"
          hint="显示在登录页、侧边栏与浏览器页签"
          required
        >
          <Input
            id="tenant-platform-title"
            maxLength={40}
            value={form.platformTitle}
            onChange={(e) => setForm({ ...form, platformTitle: e.target.value })}
            disabled={!canUpdate}
          />
        </Field>
        <div className="grid gap-5 md:grid-cols-2">
          <LogoField
            id="tenant-platform-logo"
            label="平台logo"
            hint={`显示在登录页与侧边栏；PNG/JPG/ICO/WEBP，不超过 ${LOGO_MAX_KB} KB，不支持 SVG`}
            value={form.platformLogo}
            disabled={!canUpdate}
            onChange={(platformLogo) => setForm({ ...form, platformLogo })}
            onError={toastError}
          />
          <LogoField
            id="tenant-tab-logo"
            label="页签logo"
            hint={`浏览器页签图标（favicon）；PNG/JPG/ICO/WEBP，不超过 ${LOGO_MAX_KB} KB，不支持 SVG`}
            value={form.tabLogo}
            disabled={!canUpdate}
            onChange={(tabLogo) => setForm({ ...form, tabLogo })}
            onError={toastError}
          />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {CONTACT_FIELDS.map((f) => (
            <Field key={f.key} label={f.label} htmlFor={`tenant-${f.key}`}>
              <Input
                id={`tenant-${f.key}`}
                type={f.type}
                maxLength={f.maxLength}
                value={form[f.key]}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                disabled={!canUpdate}
              />
            </Field>
          ))}
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <Button
            aria-label="保存平台品牌"
            onClick={() => save.mutate()}
            disabled={!canUpdate || save.isPending || !form.platformTitle.trim()}
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
