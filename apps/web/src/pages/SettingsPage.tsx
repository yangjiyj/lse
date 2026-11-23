import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { hashKey, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  FileClock,
  KeyRound,
  LockKeyhole,
  Network,
  Plug,
  RefreshCw,
  Save,
  ShieldAlert,
} from 'lucide-react';
import {
  api,
  ApiError,
  type AccessSettings,
  type AuditSettings,
  type GatewaySettings,
  type ModelTarget,
  type ModelTestResult,
  type SystemSettingsUpdate,
} from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { LoadingBlock, Spinner } from '@/components/ui/spinner';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/PageHeader';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ScopePolicySettingsCard } from '@/components/service-assurance/ScopePolicySettingsCard';
import { CustomRiskSettingsCard } from '@/components/CustomRiskSettingsCard';
import { LicensePage } from './LicensePage';
import { RedTeamPolicyPage } from './RedTeamPolicyPage';
import { ShieldCheck as SecuritySettingsIcon } from 'lucide-react';
import { SecuritySettingsCard } from '@/components/settings/SecuritySettingsCard';
import { Building2 as TenantSettingsIcon } from 'lucide-react';
import { TenantSettingsCard } from '@/components/settings/TenantSettingsCard';
import { SlidersHorizontal as EvaluationConfigIcon } from 'lucide-react';
import { EvaluationConfigCard } from '@/components/settings/EvaluationConfigCard';
import { Lock as DataSecurityIcon } from 'lucide-react';
import { DataSecurityCard } from '@/components/settings/DataSecurityCard';

const SETTINGS_SECTIONS = [
  {
    id: 'access',
    title: '访问与登录',
    description: '入口与会话安全',
    hash: 'access-settings',
    icon: LockKeyhole,
    permission: null,
  },
  {
    id: 'audit',
    title: '审计与留存',
    description: '证据与归档策略',
    hash: 'audit-settings',
    icon: FileClock,
    permission: null,
  },
  {
    id: 'gateway',
    title: '网关联动',
    description: '流量证据接入',
    hash: 'gateway-settings',
    icon: Network,
    permission: null,
  },
  {
    id: 'scope',
    title: '服务核验授权范围',
    description: '核验目标范围',
    hash: 'service-assurance-scope',
    icon: LockKeyhole,
    permission: null,
  },
  {
    id: 'review',
    title: '独立判定模型',
    description: '辅助复核结果',
    hash: 'independent-judge-model',
    icon: Bot,
    permission: null,
  },
  {
    id: 'license',
    title: '授权许可',
    description: '授权状态与续期',
    hash: 'license-settings',
    icon: KeyRound,
    permission: 'license:read',
  },
  {
    id: 'redteam',
    title: '对抗评估配置',
    description: '攻击模型与停止条件',
    hash: 'redteam-policy',
    icon: ShieldAlert,
    permission: 'redteam_setting:read',
  },
  {
    id: 'security',
    title: '安全设置',
    description: '密码策略与登录锁定',
    hash: 'security-settings',
    icon: SecuritySettingsIcon,
    permission: null,
  },
  {
    id: 'tenant',
    title: '平台品牌',
    description: '配置平台 logo、页签 logo 和平台标题',
    hash: 'tenant-settings',
    icon: TenantSettingsIcon,
    permission: null,
  },
  {
    id: 'evaluation',
    title: '配置管理',
    description: '评估权重与单次评估题数',
    hash: 'evaluation-config',
    icon: EvaluationConfigIcon,
    permission: null,
  },
  {
    id: 'data_security',
    title: '数据安全',
    description: '敏感信息脱敏与下载水印',
    hash: 'data-security',
    icon: DataSecurityIcon,
    permission: null,
  },
] as const;

type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

function sectionFromHash(hash: string): SettingsSectionId | null {
  const normalizedHash = hash.replace(/^#/, '');
  return SETTINGS_SECTIONS.find((section) => section.hash === normalizedHash)?.id ?? null;
}

interface ReviewModelForm {
  baseUrl: string;
  model: string;
  apiKey: string;
  isActive: boolean;
}

const EMPTY_REVIEW_FORM: ReviewModelForm = {
  baseUrl: '',
  model: '',
  apiKey: '',
  isActive: true,
};

function defaultAccessSettings(): AccessSettings {
  return {
    encryptedLoginUrl: '',
    compatibleLoginUrl: '',
    loginPolicy: '保留兼容入口，引导使用加密入口',
    sessionPolicy: '签名会话令牌与权限校验',
  };
}

const DEFAULT_AUDIT_SETTINGS: AuditSettings = {
  operationAudit: true,
  evidenceRetention: '请求、响应与判定结果',
  logRedaction: '按规则脱敏',
  retentionDays: 180,
  externalArchive: false,
  archiveTarget: '',
};

const DEFAULT_GATEWAY_SETTINGS: GatewaySettings = {
  gatewayBaseUrl: '',
  gatewayLinkageEnabled: false,
};

function enabledText(value: boolean): string {
  return value ? '已启用' : '未启用';
}

function reviewTargetFrom(items: ModelTarget[] | undefined): ModelTarget | null {
  return items?.find((item) => item.targetType === 'JUDGE') ?? null;
}

function reviewConnectionIdentity(target: ModelTarget | null): string {
  // 使用稳定的对象键顺序；更新时间和启停状态不改变连接本身。
  return hashKey([
    target && {
      id: target.id,
      provider: target.provider,
      baseUrl: target.baseUrl,
      model: target.model,
      apiKeyMasked: target.apiKeyMasked,
      hasApiKey: target.hasApiKey,
      extraHeaders: target.extraHeaders,
      defaultParams: target.defaultParams,
      accessConfig: target.accessConfig,
    },
  ]);
}

function reviewPayload(form: ReviewModelForm, target: ModelTarget | null): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: 'AI复核',
    targetType: 'JUDGE',
    provider: 'openai-compatible',
    baseUrl: form.baseUrl.trim(),
    model: form.model.trim(),
    isActive: form.isActive,
    isGlobal: true,
  };
  if (form.apiKey.trim()) payload.apiKey = form.apiKey.trim();
  if (!target && !form.apiKey.trim()) payload.apiKey = '';
  return payload;
}

function canSaveReview(form: ReviewModelForm, target: ModelTarget | null): boolean {
  return Boolean(form.baseUrl.trim() && form.model.trim() && (target || form.apiKey.trim()));
}

function formatReviewStatus(status: string | null | undefined): string {
  if (!status) return '未测试';
  const map: Record<string, string> = {
    SUCCESS: '成功',
    FAILED: '失败',
    ERROR: '失败',
    TIMEOUT: '超时',
    PENDING: '测试中',
    RUNNING: '测试中',
  };
  return map[status] ?? '未知（请重新测试连接）';
}

function formatDuration(ms: number | null | undefined): string {
  return typeof ms === 'number' ? `${Math.round(ms)} 毫秒` : '';
}

function ReadOnlyNotice({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-severity-medium/30 bg-severity-medium-bg px-3 py-2 text-sm leading-6 text-severity-medium">
      {children}
    </div>
  );
}

function CardFooterActions({
  updatedAt,
  children,
}: {
  updatedAt: string | null | undefined;
  children: ReactNode;
}) {
  return (
    <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-4">
      {children}
      {updatedAt ? (
        <span className="text-xs text-ink-3">最近更新：{formatDateTime(updatedAt)}</span>
      ) : null}
    </div>
  );
}

export function SettingsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { hasPermission, user } = useAuth();
  const { success, error: toastError } = useToast();
  const queryClient = useQueryClient();
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(() => {
    const fromHash = sectionFromHash(location.hash);
    if (!fromHash) return 'access';
    const section = SETTINGS_SECTIONS.find((item) => item.id === fromHash);
    if (section?.permission && !hasPermission(section.permission)) return 'access';
    return fromHash;
  });
  const sectionTabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // 授权许可与对抗评估配置按权限出现，无权限的账号看不到这两个分区。
  const visibleSections = SETTINGS_SECTIONS.filter(
    (section) => !section.permission || hasPermission(section.permission),
  );

  const canUpdatePlatform =
    hasPermission('platform_setting:update') ||
    hasPermission('system_setting:update') ||
    hasPermission('license:update');
  const canCreateReview = hasPermission('model_target:create');
  const canUpdateReview = hasPermission('model_target:update');
  const canTestReview = hasPermission('model_target:test');

  const [accessForm, setAccessForm] = useState<AccessSettings>(() => defaultAccessSettings());
  const [auditForm, setAuditForm] = useState<AuditSettings>(DEFAULT_AUDIT_SETTINGS);
  const [gatewayForm, setGatewayForm] = useState<GatewaySettings>(DEFAULT_GATEWAY_SETTINGS);
  const [reviewForm, setReviewForm] = useState<ReviewModelForm>(EMPTY_REVIEW_FORM);
  const [reviewTestResult, setReviewTestResult] = useState<ModelTestResult | null>(null);
  const [reviewTestError, setReviewTestError] = useState<string | null>(null);
  const [reviewDirty, setReviewDirty] = useState(false);
  const [reviewNeedsRetest, setReviewNeedsRetest] = useState(false);

  const settingsQuery = useQuery({
    queryKey: ['system-settings'],
    queryFn: () => api.systemSettings.get(),
  });

  const reviewQuery = useQuery({
    queryKey: ['system-review-model'],
    queryFn: () => api.modelTargets.list({ page: 1, pageSize: 200, includeSystem: true }),
  });
  const reviewTarget = reviewTargetFrom(reviewQuery.data?.items);
  const canManageReview = reviewTarget ? canUpdateReview : canCreateReview;
  const reviewConnectionChanged = Boolean(
    reviewTarget &&
    (reviewForm.baseUrl.trim() !== reviewTarget.baseUrl.trim() ||
      reviewForm.model.trim() !== reviewTarget.model.trim()),
  );
  const reviewTestNeedsSave = reviewConnectionChanged && !reviewForm.apiKey.trim();
  const reviewSaveBeforeTestMessage =
    '接口地址或模型名称已修改，使用已保存的密钥测试前，请先保存配置。';

  const editReviewForm = (next: ReviewModelForm) => {
    setReviewForm(next);
    setReviewDirty(true);
    setReviewTestResult(null);
    setReviewTestError(null);
  };

  const invalidateReviewModels = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['system-review-model'] }),
      queryClient.invalidateQueries({ queryKey: ['model-targets'] }),
    ]);

  useEffect(() => {
    setActiveSection(sectionFromHash(location.hash) ?? 'access');
  }, [location.hash]);

  useEffect(() => {
    const activeIndex = SETTINGS_SECTIONS.findIndex((section) => section.id === activeSection);
    sectionTabRefs.current[activeIndex]?.scrollIntoView?.({
      block: 'nearest',
      inline: 'nearest',
    });
  }, [activeSection]);

  // 仅在首次拿到服务端配置时填充表单。后续 refetch / setQueryData 不再覆盖，
  // 否则保存任一分区都会把其他分区未保存的编辑静默重置。各分区保存后由
  // 自己 mutation 的 onSuccess 精确回填。
  const settingsHydrated = useRef(false);
  useEffect(() => {
    if (!settingsQuery.data) return;
    if (settingsHydrated.current) return;
    settingsHydrated.current = true;
    setAccessForm(settingsQuery.data.access);
    setAuditForm(settingsQuery.data.audit);
    setGatewayForm(settingsQuery.data.gateway);
  }, [settingsQuery.data]);

  const previousReviewState = useRef<{ target: ModelTarget | null; dirty: boolean } | null>(null);
  useEffect(() => {
    if (!reviewQuery.data) return;
    const previous = previousReviewState.current;
    previousReviewState.current = { target: reviewTarget, dirty: reviewDirty };
    // 临时配置及其测试结果属于当前草稿，后台变更不能覆盖。
    if (reviewDirty) return;
    const connectionChanged =
      previous &&
      (reviewConnectionIdentity(previous.target) !== reviewConnectionIdentity(reviewTarget) ||
        (previous.target?.lastTestStatus != null && reviewTarget?.lastTestStatus == null));
    if (connectionChanged) {
      setReviewTestResult(null);
      setReviewTestError(null);
      // 本页保存结束时保留“请重新测试”；外部变更则采用新配置的服务端状态。
      if (!previous.dirty) setReviewNeedsRetest(false);
    }
    setReviewForm({
      baseUrl: reviewTarget?.baseUrl ?? '',
      model: reviewTarget?.model ?? '',
      apiKey: '',
      isActive: reviewTarget?.isActive ?? true,
    });
  }, [
    reviewDirty,
    reviewQuery.data,
    reviewTarget?.id,
    reviewTarget?.baseUrl,
    reviewTarget?.model,
    reviewTarget?.isActive,
  ]);

  const saveAccessMutation = useMutation({
    mutationFn: (body: SystemSettingsUpdate) => api.systemSettings.update(body),
    onSuccess: (res) => {
      queryClient.setQueryData(['system-settings'], res);
      setAccessForm(res.access);
      success('访问与登录配置已保存');
    },
    onError: (e) => toastError(e instanceof ApiError ? e.message : '保存失败'),
  });

  const saveAuditMutation = useMutation({
    mutationFn: (body: SystemSettingsUpdate) => api.systemSettings.update(body),
    onSuccess: (res) => {
      queryClient.setQueryData(['system-settings'], res);
      setAuditForm(res.audit);
      success('审计与留存配置已保存');
    },
    onError: (e) => toastError(e instanceof ApiError ? e.message : '保存失败'),
  });

  const saveGatewayMutation = useMutation({
    mutationFn: (body: SystemSettingsUpdate) => api.systemSettings.update(body),
    onSuccess: (res) => {
      queryClient.setQueryData(['system-settings'], res);
      setGatewayForm(res.gateway);
      success('网关联动配置已保存');
    },
    onError: (e) => toastError(e instanceof ApiError ? e.message : '保存失败'),
  });

  const saveReviewMutation = useMutation({
    mutationFn: async () => {
      if (!canSaveReview(reviewForm, reviewTarget)) throw new Error('REVIEW_FORM_INVALID');
      const payload = reviewPayload(reviewForm, reviewTarget);
      if (reviewTarget) return api.modelTargets.update(reviewTarget.id, payload);
      return api.modelTargets.create(payload);
    },
    onSuccess: (target) => {
      const connectionChanged =
        !reviewTarget || reviewConnectionChanged || Boolean(reviewForm.apiKey.trim());
      if (connectionChanged) {
        setReviewNeedsRetest(true);
        setReviewTestResult(null);
        setReviewTestError(null);
      }
      queryClient.setQueryData<typeof reviewQuery.data>(['system-review-model'], (current) => ({
        ...(current ?? { page: 1, pageSize: 200 }),
        total:
          (current?.total ?? 0) + (current?.items.some((item) => item.id === target.id) ? 0 : 1),
        items: current?.items.some((item) => item.id === target.id)
          ? current.items.map((item) => (item.id === target.id ? target : item))
          : [target, ...(current?.items ?? [])],
      }));
      setReviewForm({
        baseUrl: target.baseUrl,
        model: target.model,
        apiKey: '',
        isActive: target.isActive,
      });
      setReviewDirty(false);
      success('判定模型配置已保存');
      return invalidateReviewModels();
    },
    onError: (e) => {
      if (e instanceof Error && e.message === 'REVIEW_FORM_INVALID') {
        toastError('请填写接口地址、模型名称；首次配置必须填写访问密钥。');
        return;
      }
      toastError(e instanceof ApiError ? e.message : '判定模型配置保存失败');
    },
  });

  const testReviewMutation = useMutation({
    mutationFn: async () => {
      if (!canSaveReview(reviewForm, reviewTarget)) throw new Error('REVIEW_FORM_INVALID');
      if (reviewTestNeedsSave) throw new Error('REVIEW_SAVE_BEFORE_TEST');
      if (reviewTarget && !reviewForm.apiKey.trim()) return api.modelTargets.test(reviewTarget.id);
      return api.modelTargets.testConfig({
        baseUrl: reviewForm.baseUrl.trim(),
        model: reviewForm.model.trim(),
        apiKey: reviewForm.apiKey.trim(),
        prompt: '请用一句话确认独立判定模型连接正常。',
      });
    },
    onMutate: () => {
      setReviewTestResult(null);
      setReviewTestError(null);
    },
    onSuccess: (res) => {
      setReviewTestResult(res);
      if (reviewTarget && !reviewForm.apiKey.trim()) setReviewNeedsRetest(false);
      if (res.status === 'SUCCESS') success(`判定模型连接成功 · ${formatDuration(res.latencyMs)}`);
      else {
        const message = `判定模型连接失败：${res.error ?? '未知错误'}`;
        setReviewTestError(message);
        toastError(message);
      }
      return invalidateReviewModels();
    },
    onError: (e) => {
      const message =
        e instanceof Error && e.message === 'REVIEW_SAVE_BEFORE_TEST'
          ? reviewSaveBeforeTestMessage
          : e instanceof Error && e.message === 'REVIEW_FORM_INVALID'
            ? '请先填写可测试的判定模型配置。'
            : e instanceof ApiError
              ? e.message
              : '判定模型测试失败';
      setReviewTestError(message);
      toastError(message);
    },
  });

  const testGatewayMutation = useMutation({
    mutationFn: (gatewayBaseUrl: string) => api.systemSettings.testGateway(gatewayBaseUrl),
    onSuccess: (res) => {
      if (res.ok)
        success(
          `${res.message || '连接成功'}${res.latencyMs != null ? ` · ${res.latencyMs}ms` : ''}`,
        );
      else toastError(`连接失败：${res.message || '未知错误'}`);
    },
    onError: (e) => toastError(e instanceof ApiError ? e.message : '测试失败'),
  });

  const activateSection = (sectionId: SettingsSectionId) => {
    const section = visibleSections.find((item) => item.id === sectionId);
    if (!section) return;
    setActiveSection(sectionId);
    navigate(
      {
        pathname: location.pathname,
        search: location.search,
        hash: `#${section.hash}`,
      },
      { replace: true, preventScrollReset: true },
    );
  };

  const handleSectionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (index + 1) % visibleSections.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (index - 1 + visibleSections.length) % visibleSections.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = visibleSections.length - 1;
    }

    if (nextIndex === null) return;
    const nextSection = visibleSections[nextIndex];
    if (!nextSection) return;
    event.preventDefault();
    activateSection(nextSection.id);
    sectionTabRefs.current[nextIndex]?.focus();
  };

  if (settingsQuery.isLoading) {
    return (
      <div className="rounded-lg border border-line bg-white shadow-sm">
        <LoadingBlock label="正在加载平台设置…" />
      </div>
    );
  }

  const settings = settingsQuery.data;
  const gatewayAddressUnchanged =
    gatewayForm.gatewayBaseUrl.trim() === (settings?.gateway.gatewayBaseUrl ?? '').trim();
  const gatewayAddressAuthorization = gatewayAddressUnchanged
    ? settings?.gateway.addressAuthorization
    : 'PENDING_CHECK';
  const reviewConfigured = Boolean(
    reviewTarget?.hasApiKey && reviewTarget.baseUrl && reviewTarget.model,
  );
  const latestReviewTest = reviewTestResult
    ? `${formatReviewStatus(reviewTestResult.status)}${reviewTestResult.latencyMs !== null ? ` · ${formatDuration(reviewTestResult.latencyMs)}` : ''}`
    : reviewTestError
      ? '失败'
      : reviewNeedsRetest
        ? '配置已变更，请重新测试'
        : reviewTarget?.lastTestStatus
          ? `${formatReviewStatus(reviewTarget.lastTestStatus)} · ${formatDateTime(reviewTarget.lastTestedAt)}`
          : '未测试';

  return (
    <section aria-label="平台配置" className="space-y-5">
      <PageHeader
        title="平台设置"
        description="集中管理访问控制、审计留存、网关联动、功能开关与独立判定模型"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              settingsQuery.refetch();
              reviewQuery.refetch();
              queryClient.invalidateQueries({ queryKey: ['license'] });
            }}
            disabled={settingsQuery.isFetching || reviewQuery.isFetching}
          >
            <RefreshCw className="h-4 w-4" />
            刷新
          </Button>
        }
      />

      {Boolean(user?.roles?.includes('admin') || user?.roles?.includes('tenant_admin')) && <div className="flex justify-end"><Link className="inline-flex items-center gap-2 text-sm text-brand-700 hover:underline" to="/settings/api-tokens"><KeyRound className="h-4 w-4" />API 令牌</Link></div>}

      <div className="gap-5 lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start">
        <nav
          role="tablist"
          aria-label="平台设置分类"
          className="mb-4 flex gap-1 overflow-x-auto rounded-card border border-line bg-white p-2 shadow-card lg:sticky lg:top-4 lg:mb-0 lg:flex-col"
        >
          {visibleSections.map((section, index) => {
            const Icon = section.icon;
            const isActive = section.id === activeSection;
            return (
              <button
                key={section.id}
                ref={(node) => {
                  sectionTabRefs.current[index] = node;
                }}
                id={`settings-tab-${section.id}`}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-controls={`settings-panel-${section.id}`}
                tabIndex={isActive ? 0 : -1}
                onClick={() => activateSection(section.id)}
                onKeyDown={(event) => handleSectionKeyDown(event, index)}
                className={cn(
                  'flex min-h-11 min-w-36 flex-none items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/40 lg:w-full lg:min-w-0',
                  isActive
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-ink-2 hover:bg-canvas hover:text-ink',
                )}
              >
                <Icon
                  className={cn(
                    'h-[18px] w-[18px] shrink-0',
                    isActive ? 'text-brand-600' : 'text-ink-3',
                  )}
                />
                <span className="min-w-0">
                  <span className="block whitespace-nowrap text-sm font-medium">
                    {section.title}
                  </span>
                  <span className="mt-0.5 hidden truncate text-[12.5px] font-normal text-ink-3 lg:block">
                    {section.description}
                  </span>
                </span>
              </button>
            );
          })}
        </nav>

        <div className="min-w-0 overflow-hidden rounded-card border border-line bg-white shadow-card">
          <div
            id="settings-panel-access"
            role="tabpanel"
            aria-labelledby="settings-tab-access"
            hidden={activeSection !== 'access'}
          >
            {/* 卡片 1：访问与登录 */}
            <Card id="access-settings" className="scroll-mt-5 rounded-none border-0 shadow-none">
              <CardHeader className="border-b border-line pb-4">
                <div className="flex items-center gap-2">
                  <LockKeyhole className="h-5 w-5 text-primary" />
                  <CardTitle>访问与登录</CardTitle>
                  <Badge
                    tone={
                      accessForm.encryptedLoginUrl && accessForm.compatibleLoginUrl
                        ? 'success'
                        : 'neutral'
                    }
                  >
                    {accessForm.encryptedLoginUrl && accessForm.compatibleLoginUrl
                      ? '已配置'
                      : '未配置'}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4 pt-5">
                {!canUpdatePlatform ? (
                  <ReadOnlyNotice>
                    当前账号没有权限修改访问与登录配置，以下为只读展示。
                  </ReadOnlyNotice>
                ) : null}
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="加密访问入口" htmlFor="access-encrypted-url" required>
                    <Input
                      id="access-encrypted-url"
                      aria-label="加密访问入口"
                      placeholder="未配置，请填写实际访问地址"
                      value={accessForm.encryptedLoginUrl}
                      onChange={(e) =>
                        setAccessForm({ ...accessForm, encryptedLoginUrl: e.target.value })
                      }
                      disabled={!canUpdatePlatform}
                      className="font-mono text-xs"
                    />
                  </Field>
                  <Field label="兼容访问入口" htmlFor="access-compatible-url" required>
                    <Input
                      id="access-compatible-url"
                      aria-label="兼容访问入口"
                      placeholder="未配置，请填写实际访问地址"
                      value={accessForm.compatibleLoginUrl}
                      onChange={(e) =>
                        setAccessForm({ ...accessForm, compatibleLoginUrl: e.target.value })
                      }
                      disabled={!canUpdatePlatform}
                      className="font-mono text-xs"
                    />
                  </Field>
                </div>
                <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-lg border border-line bg-canvas px-4 py-3 text-sm">
                  {(!accessForm.encryptedLoginUrl || !accessForm.compatibleLoginUrl) && (
                    <p className="col-span-2 text-ink-3">未配置，请填写实际访问地址</p>
                  )}
                  <dt className="text-ink-3">登录方式</dt>
                  <dd className="text-ink-2">地址按请求主机及默认端口推导，请按实际部署确认</dd>
                  <dt className="text-ink-3">登录安全</dt>
                  <dd className="text-ink-2">登录后自动校验身份和权限</dd>
                </dl>
                <CardFooterActions updatedAt={settings?.updatedAt.access}>
                  <Button
                    aria-label="保存访问与登录配置"
                    onClick={() => saveAccessMutation.mutate({ access: accessForm })}
                    disabled={!canUpdatePlatform || saveAccessMutation.isPending}
                  >
                    {saveAccessMutation.isPending ? (
                      <Spinner className="h-4 w-4" />
                    ) : (
                      <Save className="h-4 w-4" />
                    )}
                    保存配置
                  </Button>
                </CardFooterActions>
              </CardContent>
            </Card>
          </div>

          <div
            id="settings-panel-audit"
            role="tabpanel"
            aria-labelledby="settings-tab-audit"
            hidden={activeSection !== 'audit'}
          >
            {/* 卡片 2：审计与留存 */}
            <Card id="audit-settings" className="scroll-mt-5 rounded-none border-0 shadow-none">
              <CardHeader className="border-b border-line pb-4">
                <div className="flex items-center gap-2">
                  <FileClock className="h-5 w-5 text-primary" />
                  <CardTitle>审计与留存</CardTitle>
                  <Badge tone={auditForm.operationAudit ? 'success' : 'warning'}>
                    {enabledText(auditForm.operationAudit)}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4 pt-5">
                {!canUpdatePlatform ? (
                  <ReadOnlyNotice>
                    当前账号没有权限修改审计与留存配置，以下为只读展示。
                  </ReadOnlyNotice>
                ) : null}
                <label className="flex items-center gap-2 text-sm text-ink-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4 shrink-0 accent-primary"
                    checked={auditForm.operationAudit}
                    onChange={(e) =>
                      setAuditForm({ ...auditForm, operationAudit: e.target.checked })
                    }
                    disabled={!canUpdatePlatform}
                  />
                  启用操作审计
                </label>
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="证据留存范围" htmlFor="audit-evidence-retention">
                    <Select
                      id="audit-evidence-retention"
                      aria-label="证据留存范围"
                      value={auditForm.evidenceRetention}
                      onChange={(e) =>
                        setAuditForm({ ...auditForm, evidenceRetention: e.target.value })
                      }
                      disabled={!canUpdatePlatform}
                    >
                      {auditForm.evidenceRetention &&
                      auditForm.evidenceRetention !== '请求、响应与判定结果' &&
                      auditForm.evidenceRetention !== '仅判定结果' ? (
                        <option value={auditForm.evidenceRetention}>
                          {auditForm.evidenceRetention}
                        </option>
                      ) : null}
                      <option value="请求、响应与判定结果">完整交互与判定结果（推荐）</option>
                      <option value="仅判定结果">仅判定结果</option>
                    </Select>
                  </Field>
                  <Field
                    label="敏感日志处理"
                    htmlFor="audit-log-redaction"
                    hint="手机号、密钥等敏感信息将在保存前自动脱敏。"
                  >
                    <Select
                      id="audit-log-redaction"
                      aria-label="敏感日志处理"
                      value={auditForm.logRedaction}
                      onChange={(e) => setAuditForm({ ...auditForm, logRedaction: e.target.value })}
                      disabled={!canUpdatePlatform}
                    >
                      {auditForm.logRedaction &&
                      auditForm.logRedaction !== '按规则脱敏' &&
                      auditForm.logRedaction !== '不打码' ? (
                        <option value={auditForm.logRedaction}>{auditForm.logRedaction}</option>
                      ) : null}
                      <option value="按规则脱敏">自动脱敏（推荐）</option>
                      <option value="不打码">不脱敏</option>
                    </Select>
                  </Field>
                  <Field label="留存天数" htmlFor="audit-retention-days" required>
                    <Input
                      id="audit-retention-days"
                      aria-label="留存天数"
                      type="number"
                      min={1}
                      max={3650}
                      value={auditForm.retentionDays === 0 ? '' : auditForm.retentionDays}
                      onChange={(e) =>
                        setAuditForm({
                          ...auditForm,
                          retentionDays: e.target.value ? Number(e.target.value) : 0,
                        })
                      }
                      disabled={!canUpdatePlatform}
                    />
                  </Field>
                </div>
                <label className="flex items-center gap-2 text-sm text-ink-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4 shrink-0 accent-primary"
                    checked={auditForm.externalArchive}
                    onChange={(e) =>
                      setAuditForm({ ...auditForm, externalArchive: e.target.checked })
                    }
                    disabled={!canUpdatePlatform}
                  />
                  启用外部归档
                </label>
                <Field label="归档位置" htmlFor="audit-archive-target">
                  <Input
                    id="audit-archive-target"
                    aria-label="归档位置"
                    value={auditForm.archiveTarget}
                    onChange={(e) => setAuditForm({ ...auditForm, archiveTarget: e.target.value })}
                    disabled={!canUpdatePlatform}
                    placeholder="例如 SFTP 地址、共享盘路径或第三方审计平台名称"
                  />
                </Field>
                <div className="border-t border-line pt-3">
                  <Link to="/audit-logs" className="text-sm text-primary hover:underline">
                    查看操作日志 →
                  </Link>
                </div>
                <CardFooterActions updatedAt={settings?.updatedAt.audit}>
                  <Button
                    aria-label="保存审计与留存配置"
                    onClick={() => saveAuditMutation.mutate({ audit: auditForm })}
                    disabled={!canUpdatePlatform || saveAuditMutation.isPending}
                  >
                    {saveAuditMutation.isPending ? (
                      <Spinner className="h-4 w-4" />
                    ) : (
                      <Save className="h-4 w-4" />
                    )}
                    保存配置
                  </Button>
                </CardFooterActions>
              </CardContent>
            </Card>
          </div>

          <div
            id="settings-panel-gateway"
            role="tabpanel"
            aria-labelledby="settings-tab-gateway"
            hidden={activeSection !== 'gateway'}
          >
            {/* 卡片 3：网关联动 */}
            <Card id="gateway-settings" className="scroll-mt-5 rounded-none border-0 shadow-none">
              <CardHeader className="border-b border-line pb-4">
                <div className="flex items-center gap-2">
                  <Network className="h-5 w-5 text-primary" />
                  <CardTitle>网关联动</CardTitle>
                  <Badge tone={settings?.gateway.secretConfigured ? 'success' : 'warning'}>
                    {settings?.gateway.secretConfigured ? '已接入' : '未接入'}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4 pt-5">
                {!canUpdatePlatform ? (
                  <ReadOnlyNotice>
                    当前账号没有权限修改网关联动配置，以下为只读展示。
                  </ReadOnlyNotice>
                ) : null}
                <label className="flex items-center gap-2 text-sm text-ink-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4 shrink-0 accent-primary"
                    checked={gatewayForm.gatewayLinkageEnabled}
                    onChange={(e) =>
                      setGatewayForm({ ...gatewayForm, gatewayLinkageEnabled: e.target.checked })
                    }
                    disabled={!canUpdatePlatform}
                  />
                  关联安全网关流量证据（可选）
                </label>
                <p className="-mt-2 text-xs leading-6 text-ink-3">
                  默认关闭。关闭后，平台不调用安全网关，评估报告不展示网关拦截与放行记录。
                </p>
                <Field
                  label="网关控制台地址（全局默认）"
                  htmlFor="gateway-base-url"
                  hint="填写安全网关控制台地址，保存前可使用「测试连接」验证连通性。"
                >
                  <Input
                    id="gateway-base-url"
                    aria-label="网关控制台地址"
                    value={gatewayForm.gatewayBaseUrl}
                    onChange={(e) =>
                      setGatewayForm({ ...gatewayForm, gatewayBaseUrl: e.target.value })
                    }
                    disabled={!canUpdatePlatform}
                    placeholder="例如 192.168.1.10:8080"
                    className="font-mono text-xs"
                  />
                </Field>
                {gatewayForm.gatewayBaseUrl.trim() ? (
                  <div
                    className={cn(
                      'rounded-lg border px-4 py-3 text-xs leading-6',
                      gatewayAddressAuthorization === 'NOT_AUTHORIZED' ||
                        gatewayAddressAuthorization === 'INVALID'
                        ? 'border-red-200 bg-severity-critical-bg text-severity-critical'
                        : gatewayAddressAuthorization === 'AUTHORIZED'
                          ? 'border-emerald-200 bg-severity-pass-bg text-severity-pass'
                          : 'border-severity-medium/30 bg-severity-medium-bg text-severity-medium',
                    )}
                  >
                    {gatewayAddressAuthorization === 'NOT_AUTHORIZED'
                      ? '当前网关地址未获部署授权，保存和联动请求将被拒绝。请联系部署管理员授权该地址。'
                      : gatewayAddressAuthorization === 'INVALID'
                        ? '当前网关地址格式无效，请检查后重新填写。'
                        : gatewayAddressAuthorization === 'AUTHORIZED'
                          ? '访问授权：已授权'
                          : '地址已修改，保存时将校验部署访问授权。'}
                  </div>
                ) : null}
                <div className="flex items-center gap-3">
                  <Button
                    variant="outline"
                    onClick={() => testGatewayMutation.mutate(gatewayForm.gatewayBaseUrl)}
                    disabled={!canUpdatePlatform || testGatewayMutation.isPending}
                  >
                    {testGatewayMutation.isPending ? (
                      <Spinner className="h-4 w-4" />
                    ) : (
                      <Plug className="h-4 w-4" />
                    )}
                    测试连接
                  </Button>
                </div>
                <div className="rounded-lg border border-line px-4 py-3">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-ink-2">接口凭据</span>
                    <span
                      className={cn(
                        'shrink-0',
                        settings?.gateway.secretConfigured
                          ? 'text-severity-pass'
                          : 'text-severity-high',
                      )}
                    >
                      {settings?.gateway.secretConfigured ? '✓ 已配置' : '✗ 未配置'}
                    </span>
                  </div>
                  {settings?.gateway.secretConfigured ? null : (
                    <details className="mt-2 text-xs text-ink-3">
                      <summary className="cursor-pointer select-none">查看技术细节</summary>
                      <p className="mt-1 leading-6">
                        需在部署环境设置环境变量{' '}
                        <code className="font-mono">NEWAPI_EVAL_INTEGRATION_TOKEN</code>。
                      </p>
                    </details>
                  )}
                </div>
                <CardFooterActions updatedAt={settings?.updatedAt.gateway}>
                  <Button
                    aria-label="保存网关联动配置"
                    onClick={() =>
                      saveGatewayMutation.mutate({
                        gateway: {
                          gatewayBaseUrl: gatewayForm.gatewayBaseUrl,
                          gatewayLinkageEnabled: gatewayForm.gatewayLinkageEnabled,
                        },
                      })
                    }
                    disabled={!canUpdatePlatform || saveGatewayMutation.isPending}
                  >
                    {saveGatewayMutation.isPending ? (
                      <Spinner className="h-4 w-4" />
                    ) : (
                      <Save className="h-4 w-4" />
                    )}
                    保存配置
                  </Button>
                </CardFooterActions>
              </CardContent>
            </Card>
          </div>

          <div
            id="settings-panel-scope"
            role="tabpanel"
            aria-labelledby="settings-tab-scope"
            hidden={activeSection !== 'scope'}
          >
            <ScopePolicySettingsCard
              canUpdate={canUpdatePlatform}
              className="rounded-none border-0 shadow-none"
            />
          </div>

          <div
            id="settings-panel-review"
            role="tabpanel"
            aria-labelledby="settings-tab-review"
            hidden={activeSection !== 'review'}
          >
            {/* 卡片 5：独立判定模型 */}
            <Card
              id="independent-judge-model"
              className="scroll-mt-5 rounded-none border-0 shadow-none"
            >
              <CardHeader className="border-b border-line pb-4">
                <div className="flex items-center gap-2">
                  <Bot className="h-5 w-5 text-primary" />
                  <CardTitle>独立判定模型</CardTitle>
                  <Badge tone={reviewConfigured && !reviewDirty ? 'neutral' : 'warning'}>
                    {reviewDirty
                      ? '有未保存的变更'
                      : !reviewConfigured
                        ? '待配置'
                        : !reviewTarget?.isActive
                          ? '已停用'
                          : !reviewNeedsRetest &&
                              ['FAILED', 'ERROR', 'TIMEOUT'].includes(
                                reviewTarget?.lastTestStatus ?? '',
                              )
                            ? '已保存 · 测试失败'
                            : '已保存'}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4 pt-5">
                <ReadOnlyNotice>
                  配置独立模型用于辅助复核评估结果。判定模型必须与评估对象不同，以降低同源偏差。
                </ReadOnlyNotice>
                <div className="grid gap-4 md:grid-cols-2">
                  <Field
                    label="接口地址"
                    htmlFor="review-base-url"
                    required
                    hint="填写模型提供方或自建中转的兼容接口地址，例如 https://gateway.example.com/v1。"
                  >
                    <Input
                      id="review-base-url"
                      aria-label="接口地址"
                      disabled={saveReviewMutation.isPending || testReviewMutation.isPending}
                      value={reviewForm.baseUrl}
                      onChange={(e) => editReviewForm({ ...reviewForm, baseUrl: e.target.value })}
                      placeholder="https://gateway.example.com/v1"
                      className="font-mono text-xs"
                    />
                  </Field>
                  <Field
                    label="模型名称"
                    htmlFor="review-model"
                    required
                    hint="填写提供方给出的模型标识，例如 gpt-4o、glm-4、deepseek-chat。"
                  >
                    <Input
                      id="review-model"
                      autoComplete="off"
                      aria-label="模型名称"
                      disabled={saveReviewMutation.isPending || testReviewMutation.isPending}
                      value={reviewForm.model}
                      onChange={(e) => editReviewForm({ ...reviewForm, model: e.target.value })}
                      placeholder="例如 gpt-4o"
                    />
                  </Field>
                  <Field
                    label="访问密钥"
                    htmlFor="review-api-key"
                    hint={reviewTarget ? '留空则保持原密钥；填写后会替换。' : '首次配置必须填写。'}
                  >
                    <Input
                      id="review-api-key"
                      autoComplete="new-password"
                      aria-label="访问密钥"
                      disabled={saveReviewMutation.isPending || testReviewMutation.isPending}
                      type="password"
                      value={reviewForm.apiKey}
                      onChange={(e) => editReviewForm({ ...reviewForm, apiKey: e.target.value })}
                      placeholder={reviewTarget ? '留空表示不修改' : '输入访问密钥'}
                    />
                  </Field>
                </div>
                <label className="flex items-center gap-2 text-sm text-ink-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4 shrink-0 accent-primary"
                    checked={reviewForm.isActive}
                    disabled={saveReviewMutation.isPending || testReviewMutation.isPending}
                    onChange={(e) => editReviewForm({ ...reviewForm, isActive: e.target.checked })}
                  />
                  启用独立判定模型
                </label>
                {reviewTestNeedsSave ? (
                  <ReadOnlyNotice>{reviewSaveBeforeTestMessage}</ReadOnlyNotice>
                ) : null}
                {reviewTestError ? (
                  <p
                    role="alert"
                    className="rounded-lg border border-severity-critical/30 bg-severity-critical-bg px-3 py-2 text-sm text-severity-critical"
                  >
                    {reviewTestError}
                  </p>
                ) : null}
                <CardFooterActions updatedAt={undefined}>
                  <Button
                    variant="outline"
                    onClick={() => testReviewMutation.mutate()}
                    disabled={
                      !canTestReview ||
                      testReviewMutation.isPending ||
                      saveReviewMutation.isPending ||
                      reviewTestNeedsSave ||
                      !canSaveReview(reviewForm, reviewTarget)
                    }
                  >
                    {testReviewMutation.isPending ? (
                      <Spinner className="h-4 w-4" />
                    ) : (
                      <Plug className="h-4 w-4" />
                    )}
                    测试连接
                  </Button>
                  <Button
                    aria-label="保存判定模型配置"
                    onClick={() => saveReviewMutation.mutate()}
                    disabled={
                      !canManageReview ||
                      saveReviewMutation.isPending ||
                      testReviewMutation.isPending ||
                      !canSaveReview(reviewForm, reviewTarget)
                    }
                  >
                    {saveReviewMutation.isPending ? (
                      <Spinner className="h-4 w-4" />
                    ) : (
                      <Save className="h-4 w-4" />
                    )}
                    保存配置
                  </Button>
                  <span className="text-sm text-ink-3">
                    {reviewForm.apiKey.trim() && reviewTestResult ? '未保存配置测试' : '最近测试'}：
                    {latestReviewTest}
                  </span>
                </CardFooterActions>
                {!canManageReview ? (
                  <p className="text-xs text-ink-3">当前账号没有判定模型保存权限。</p>
                ) : null}
              </CardContent>
            </Card>
            {activeSection === 'review' ? (
              <CustomRiskSettingsCard
                canUpdate={
                  hasPermission('system_setting:update') || hasPermission('redteam_setting:update')
                }
                canGenerate={hasPermission('question:create')}
              />
            ) : null}
          </div>

          <div
            id="settings-panel-security"
            role="tabpanel"
            aria-labelledby="settings-tab-security"
            hidden={activeSection !== 'security'}
          >
            {activeSection === 'security' ? (
              <SecuritySettingsCard canUpdate={canUpdatePlatform} />
            ) : null}
          </div>

          <div
            id="settings-panel-tenant"
            role="tabpanel"
            aria-labelledby="settings-tab-tenant"
            hidden={activeSection !== 'tenant'}
          >
            {activeSection === 'tenant' ? (
              <TenantSettingsCard canUpdate={canUpdatePlatform} />
            ) : null}
          </div>

          <div
            id="settings-panel-evaluation"
            role="tabpanel"
            aria-labelledby="settings-tab-evaluation"
            hidden={activeSection !== 'evaluation'}
          >
            {activeSection === 'evaluation' ? (
              <EvaluationConfigCard canUpdate={canUpdatePlatform} />
            ) : null}
          </div>

          <div
            id="settings-panel-data_security"
            role="tabpanel"
            aria-labelledby="settings-tab-data_security"
            hidden={activeSection !== 'data_security'}
          >
            {activeSection === 'data_security' ? (
              <DataSecurityCard canUpdate={canUpdatePlatform} />
            ) : null}
          </div>

          <div
            id="settings-panel-license"
            role="tabpanel"
            aria-labelledby="settings-tab-license"
            hidden={activeSection !== 'license'}
            className="p-5"
          >
            {activeSection === 'license' && hasPermission('license:read') ? <LicensePage /> : null}
          </div>

          <div
            id="settings-panel-redteam"
            role="tabpanel"
            aria-labelledby="settings-tab-redteam"
            hidden={activeSection !== 'redteam'}
            className="p-5"
          >
            {activeSection === 'redteam' && hasPermission('redteam_setting:read') ? (
              <RedTeamPolicyPage embedded />
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
