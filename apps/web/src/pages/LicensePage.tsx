import { useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Info, ShieldCheck, Upload, X, type LucideIcon } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { LoadingBlock } from '@/components/ui/spinner';
import { LicenseStatusBadge } from '@/components/ui/status-badge';
import { formatDateTime, type BadgeTone } from '@/lib/format';
import { cn } from '@/lib/utils';

type SettingsSection = 'license';

interface SummaryItem {
  label: string;
  value: ReactNode;
  mono?: boolean;
}

interface SectionMeta {
  key: SettingsSection;
  title: string;
  description: string;
  icon: LucideIcon;
  status: string;
  tone: BadgeTone;
  items: SummaryItem[];
}

function SummaryRow({ label, value, mono = false }: SummaryItem) {
  return (
    <div className="grid gap-1 border-b border-line py-3 last:border-0 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-center">
      <div className="text-sm text-ink-3">{label}</div>
      <div
        className={cn('min-w-0 text-sm font-medium text-ink', mono && 'truncate font-mono text-xs')}
      >
        {value}
      </div>
    </div>
  );
}

function DrawerRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-line py-3 last:border-0 sm:grid-cols-[9rem_minmax(0,1fr)]">
      <div className="text-sm text-ink-3">{label}</div>
      <div className="min-w-0 text-sm font-medium text-ink">{children}</div>
    </div>
  );
}

// 把授权校验返回的原始状态/原因码翻成客户看得懂的中文原因。
function licenseFailureReason(raw: string | null | undefined): string {
  if (!raw) return '文件可能不完整或格式不对';
  const key = String(raw).toUpperCase();
  const map: Record<string, string> = {
    FINGERPRINT_MISMATCH: '机器指纹与签发时不一致（可能换了服务器）',
    EXPIRED: '授权已过期',
    SIGNATURE_INVALID: '文件签名校验不通过，文件可能被改动过',
    TAMPERED: '文件内容被改动过',
    PUBLIC_KEY_MISSING: '本机缺少校验公钥，请联系授权中心',
    SUBJECT_MISMATCH: '授权主体与本机不匹配',
  };
  return map[key] ?? '机器指纹和签发时不一致，或文件被改动过';
}

function SettingsDrawer({
  open,
  title,
  description,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  description: string;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        className="absolute inset-0 bg-slate-950/35"
        aria-label="关闭配置抽屉"
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="absolute right-0 top-0 flex h-full w-full max-w-[34rem] flex-col border-l border-line bg-white shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink">{title}</h2>
            <p className="mt-1 text-sm leading-6 text-ink-3">{description}</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭抽屉">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 scrollbar-thin">{children}</div>
      </aside>
    </div>
  );
}

export function LicensePage() {
  const { hasPermission } = useAuth();
  const { success, error: toastError } = useToast();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [drawerSection, setDrawerSection] = useState<SettingsSection | null>(null);

  const canUpdate = hasPermission('license:update');

  const infoQuery = useQuery({
    queryKey: ['license'],
    queryFn: () => api.license.get(),
  });

  // 本机指纹：GET /license 经脱敏后不含 fingerprint，需单独走 /license/fingerprint 取真实值。
  const fingerprintQuery = useQuery({
    queryKey: ['license-fingerprint'],
    queryFn: () => api.license.fingerprint(),
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const text = await file.text();
      return api.license.upload({ license: text });
    },
    onSuccess: (res) => {
      if (res.valid) {
        success('授权已生效，平台已解锁全部功能。');
      } else {
        toastError(
          `授权文件已保存，但没能通过校验。常见原因：${licenseFailureReason(res.reason ?? res.status)}。请点本页「导出主机信息」发回授权中心重新签发。`,
        );
      }
      setFileName('');
      if (fileRef.current) fileRef.current.value = '';
      queryClient.invalidateQueries({ queryKey: ['license'] });
    },
    onError: (e) => toastError(e instanceof ApiError ? e.message : '上传失败'),
  });

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    uploadMutation.mutate(file);
  }

  async function copyFingerprint(fp: string) {
    try {
      await navigator.clipboard.writeText(fp);
      success('机器指纹已复制');
    } catch {
      toastError('复制失败，请手动选择文本复制');
    }
  }

  const info = infoQuery.data;
  // 校验公钥以「公钥环」为准：只配了公钥环（没配单公钥）时同样能校验授权文件。
  const publicKeyReady = Boolean(info?.publicKeyRingConfigured || info?.publicKeyConfigured);

  const sections: SectionMeta[] = [
    {
      key: 'license',
      title: '授权许可',
      description: '管理本机授权、机器指纹和授权文件上传。',
      icon: ShieldCheck,
      status: info?.configured ? '已配置' : '待配置（必填）',
      tone: info?.configured ? 'success' : 'warning',
      items: [
        { label: '授权状态', value: info?.configured ? '已配置' : '未配置' },
        {
          label: '授权校验策略',
          value: info?.enforce
            ? '严格模式（授权无效时停止服务，适用于生产部署）'
            : '宽松模式（授权无效时仍可使用，仅适用于试用或演示）',
        },
        { label: '公钥状态', value: publicKeyReady ? '已配置' : '未配置' },
      ],
    },
  ];

  const drawerMeta = sections.find((section) => section.key === drawerSection) ?? null;

  function renderLicenseDrawer() {
    if (!info) return <LoadingBlock />;
    const fingerprint = fingerprintQuery.data?.fingerprint ?? '';
    return (
      <div className="space-y-5">
        <div className="rounded-md border border-line px-4 py-1">
          <DrawerRow label="配置状态">
            {info.configured ? (
              <Badge tone="success">已配置</Badge>
            ) : (
              <Badge tone="warning">未配置</Badge>
            )}
          </DrawerRow>
          <DrawerRow label="授权校验策略">
            {info.enforce ? (
              <Badge tone="danger" title="授权无效时平台将停止服务，适用于生产部署。">
                严格校验
              </Badge>
            ) : (
              <Badge tone="neutral" title="授权无效时平台仍可使用，仅适用于试用或演示。">
                宽松校验
              </Badge>
            )}
          </DrawerRow>
          <DrawerRow label="公钥状态">
            {publicKeyReady ? (
              <Badge tone="success">已配置</Badge>
            ) : (
              <Badge tone="warning">未配置</Badge>
            )}
          </DrawerRow>
          {info.license ? (
            <>
              <DrawerRow label="授权状态">
                <span className="inline-flex items-center gap-2">
                  <LicenseStatusBadge value={info.license.status} />
                  {info.license.valid ? (
                    <Badge tone="success">有效</Badge>
                  ) : (
                    <Badge tone="danger">无效</Badge>
                  )}
                </span>
              </DrawerRow>
              <DrawerRow label="授权主体">{info.license.subject ?? '—'}</DrawerRow>
              <DrawerRow label="签发时间">
                {info.license.issuedAt ? formatDateTime(info.license.issuedAt) : '—'}
              </DrawerRow>
              <DrawerRow label="到期时间">
                {info.license.expiresAt ? formatDateTime(info.license.expiresAt) : '—'}
              </DrawerRow>
              {info.license.reason ? (
                <DrawerRow label="提示">
                  <span className="text-destructive">{info.license.reason}</span>
                </DrawerRow>
              ) : null}
            </>
          ) : null}
        </div>

        {!info.license ? (
          <p className="rounded-md border border-amber-200 bg-severity-medium-bg px-3 py-2 text-sm leading-6 text-severity-medium">
            当前未安装授权文件。平台处于「宽松试用」状态（授权无效仍可继续使用），建议尽快上传正式授权文件。
          </p>
        ) : null}

        <div className="rounded-md border border-sky-100 bg-brand-50 px-4 py-3 text-sm leading-6 text-sky-900">
          <div className="mb-1 font-medium">授权申请流程</div>
          <ol className="list-decimal space-y-0.5 pl-5">
            <li>导出主机信息并提交授权中心。</li>
            <li>获取授权中心签发的授权文件。</li>
            <li>选择并上传授权文件。</li>
          </ol>
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium text-ink">本机指纹</div>
          <p className="text-xs leading-6 text-ink-3">
            本机指纹用于绑定授权文件；更换服务器后需重新申请授权。
          </p>
          <div className="flex min-w-0 items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-line bg-canvas px-3 py-2 font-mono text-xs">
              {fingerprint || '获取中…'}
            </code>
            <Button
              variant="outline"
              size="icon"
              onClick={() => copyFingerprint(fingerprint)}
              disabled={!fingerprint}
              aria-label="复制机器指纹"
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          <Button
            variant="outline"
            className="w-full"
            onClick={async () => {
              const hostInfo = await api.license.hostInfo();
              const blob = new Blob([JSON.stringify(hostInfo, null, 2)], {
                type: 'application/json',
              });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = 'host-info-lse.json';
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            导出主机信息
          </Button>
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium text-ink">上传授权文件</div>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={onPick}
          />
          <Button
            className="w-full"
            onClick={() => fileRef.current?.click()}
            disabled={!canUpdate || uploadMutation.isPending}
          >
            <Upload className="h-4 w-4" />
            {uploadMutation.isPending ? '上传中…' : '选择并上传授权文件'}
          </Button>
          {fileName ? <p className="text-xs text-ink-3">已选择：{fileName}</p> : null}
          {!canUpdate ? <p className="text-xs text-ink-3">当前账号没有授权文件上传权限。</p> : null}
          <p className="text-xs leading-6 text-ink-3">
            授权文件须由授权中心签发。启用严格校验时，机器指纹必须与签发记录一致，否则平台将停止服务。
          </p>
        </div>
      </div>
    );
  }

  function renderDrawerContent() {
    if (!drawerMeta) return null;
    if (drawerMeta.key === 'license') return renderLicenseDrawer();
    return null;
  }

  return (
    <div className="space-y-5 text-ink">
      <div className="space-y-5">
        <p className="flex max-w-3xl items-start gap-1.5 rounded-lg border border-brand-100 bg-brand-50 px-3 py-2 text-sm leading-6 text-brand-700">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>首次使用请上传由授权中心签发的授权文件。</span>
        </p>

        {infoQuery.isLoading ? (
          <div className="rounded-xl border border-line bg-white">
            <LoadingBlock />
          </div>
        ) : info ? (
          <section aria-label="配置概览" className="rounded-xl border border-line bg-white">
            <div className="flex flex-col gap-3 border-b border-line px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <ShieldCheck className="h-5 w-5 text-primary" />
                  <h2 className="text-base font-semibold text-ink">{sections[0]!.title}</h2>
                  <Badge tone={sections[0]!.tone}>{sections[0]!.status}</Badge>
                </div>
                <p className="mt-1 text-sm leading-6 text-ink-3">{sections[0]!.description}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                aria-label={`配置${sections[0]!.title}`}
                onClick={() => setDrawerSection(sections[0]!.key)}
              >
                配置
              </Button>
            </div>
            <div className="px-5 py-1">
              {sections[0]!.items.map((item) => (
                <SummaryRow key={item.label} {...item} />
              ))}
            </div>
          </section>
        ) : (
          <p className="rounded-xl border border-line bg-white px-4 py-3 text-sm text-ink-3">
            无法加载授权信息。
          </p>
        )}
      </div>

      <SettingsDrawer
        open={Boolean(drawerMeta)}
        title={drawerMeta ? `配置${drawerMeta.title}` : '配置'}
        description={drawerMeta?.description ?? ''}
        onClose={() => setDrawerSection(null)}
      >
        {renderDrawerContent()}
      </SettingsDrawer>
    </div>
  );
}
