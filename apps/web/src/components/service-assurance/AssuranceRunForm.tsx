import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  ServiceAssuranceMode,
  ServiceAssuranceReadinessResponse,
  ServiceAssuranceTargetKind,
} from '@lse/shared';
import {
  getServiceAssurancePlannedChecks,
  getServiceAssuranceLimitations,
  selectServiceAssuranceReadiness,
} from '@lse/shared';
import { Check, FileSearch, ShieldAlert, ShieldCheck, Upload } from 'lucide-react';
import type {
  EvalTask,
  ServiceAssuranceCreateRequest,
  ServiceAssuranceScopePolicy,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ASSURANCE_MODES } from './AssuranceIntro';
import {
  readServiceAssuranceSbomFile,
  serviceAssuranceSbomContentType,
  serviceAssuranceSbomFileError,
} from './sbom-file';

function urlOrigin(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
}

interface AssuranceRunFormProps {
  tasks: EvalTask[];
  selectedTaskId: string;
  onTaskChange: (taskId: string) => void;
  readiness: ServiceAssuranceReadinessResponse;
  scopePolicies: ServiceAssuranceScopePolicy[];
  canScan: boolean;
  canVerify: boolean;
  canManageScopes: boolean;
  submitting: boolean;
  onSubmit: (body: ServiceAssuranceCreateRequest) => void;
}

export function AssuranceRunForm({
  tasks,
  selectedTaskId,
  onTaskChange,
  readiness,
  scopePolicies,
  canScan,
  canVerify,
  canManageScopes,
  submitting,
  onSubmit,
}: AssuranceRunFormProps) {
  const [mode, setMode] = useState<ServiceAssuranceMode>('SAFE');
  const [targetKind, setTargetKind] =
    useState<Exclude<ServiceAssuranceTargetKind, 'SBOM' | 'MCP'>>('ENDPOINT');
  const [targetName, setTargetName] = useState('');
  const [targetUrl, setTargetUrl] = useState('');
  const [scopePolicyRef, setScopePolicyRef] = useState('');
  const [authorizationConfirmed, setAuthorizationConfirmed] = useState(false);
  const [sbomFile, setSbomFile] = useState<File | null>(null);
  const [sbomFileError, setSbomFileError] = useState<string | null>(null);
  const sbomInputRef = useRef<HTMLInputElement>(null);
  const lastAutoFilledTargetUrlRef = useRef('');
  const lastAutoFilledTargetNameRef = useRef('');
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const selectedTaskBaseUrl = selectedTask?.modelTarget?.baseUrl?.trim() ?? '';
  const offline = mode === 'SBOM';

  useEffect(() => {
    if (mode !== 'DEEP') setAuthorizationConfirmed(false);
  }, [mode]);

  useEffect(() => {
    if (offline || targetKind !== 'ENDPOINT' || !selectedTaskBaseUrl) return;
    setTargetUrl((current) => {
      if (current.trim() && current !== lastAutoFilledTargetUrlRef.current) return current;
      lastAutoFilledTargetUrlRef.current = selectedTaskBaseUrl;
      return selectedTaskBaseUrl;
    });
  }, [offline, targetKind, selectedTaskBaseUrl, selectedTaskId]);

  useEffect(() => {
    let name = '';
    if (offline) name = sbomFile?.name ?? '';
    else {
      try {
        name = new URL(targetUrl).hostname;
      } catch {
        /* incomplete URL */
      }
    }
    setTargetName((current) => {
      if (current.trim() && current !== lastAutoFilledTargetNameRef.current) return current;
      lastAutoFilledTargetNameRef.current = name;
      return name;
    });
  }, [offline, sbomFile, targetUrl]);

  useEffect(() => {
    if (offline) return;
    const origin = urlOrigin(targetUrl) ?? '';
    const matched = scopePolicies.find((policy) => policy.origins.includes(origin));
    setScopePolicyRef((current) => {
      if (matched) return matched.ref;
      if (scopePolicies.some((policy) => policy.ref === current)) return current;
      return '';
    });
  }, [offline, scopePolicies, targetUrl]);

  const selectedReadiness = useMemo(
    () => selectServiceAssuranceReadiness(readiness, mode, offline ? 'SBOM' : targetKind) ?? null,
    [mode, readiness, offline, targetKind],
  );
  const permitted = mode === 'DEEP' ? canVerify : canScan;
  const ready = selectedReadiness?.ready === true;
  const selectedPolicy = scopePolicies.find((policy) => policy.ref === scopePolicyRef) ?? null;
  const targetOrigin = urlOrigin(targetUrl) ?? '';
  const selectedTaskOrigin = urlOrigin(selectedTaskBaseUrl);
  const targetOriginMismatch =
    !offline && Boolean(targetOrigin && selectedTaskOrigin && targetOrigin !== selectedTaskOrigin);
  const targetAuthorized =
    offline || Boolean(selectedPolicy && selectedPolicy.origins.includes(targetOrigin));
  const canSubmit =
    permitted &&
    ready &&
    !!targetName.trim() &&
    (offline ? !!sbomFile && !sbomFileError : !!targetOrigin && targetAuthorized) &&
    (mode !== 'DEEP' || authorizationConfirmed) &&
    !submitting;

  const selectSbomFile = (file: File | null) => {
    setSbomFile(file);
    setSbomFileError(file ? serviceAssuranceSbomFileError(file) : null);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    const contentType = sbomFile ? serviceAssuranceSbomContentType(sbomFile) : null;
    try {
      const sbom =
        offline && sbomFile && contentType
          ? { contentType, content: await readServiceAssuranceSbomFile(sbomFile) }
          : undefined;
      onSubmit({
        ...(selectedTaskId ? { taskId: selectedTaskId } : {}),
        mode,
        targetKind: offline ? 'SBOM' : targetKind,
        targetName: targetName.trim(),
        ...(!offline ? { targetUrl: targetUrl.trim() } : {}),
        scopePolicyRef: offline ? 'not-applicable' : scopePolicyRef,
        authorizationConfirmed,
        ...(sbom ? { sbom } : {}),
      });
    } catch {
      setSbomFileError('组件清单读取失败，请重新选择文件。');
    }
  };

  return (
    <Card className="min-w-0 overflow-hidden">
      <CardHeader className="border-b border-line pb-4">
        <CardTitle>发起核验</CardTitle>
        <CardDescription>
          提供服务地址或组件清单，确认本次检查范围后开始；无需预先创建评估任务。
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-6">
        <form className="space-y-5" onSubmit={submit}>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3" role="group" aria-label="核验方式">
            {ASSURANCE_MODES.map((item) => {
              const Icon =
                item.key === 'SBOM' ? FileSearch : item.key === 'DEEP' ? ShieldAlert : ShieldCheck;
              const active = mode === item.key;
              return (
                <button
                  key={item.key}
                  aria-label={item.name}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setMode(item.key)}
                  className={cn(
                    'relative flex min-w-0 flex-col justify-start rounded-card border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600',
                    active
                      ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600'
                      : 'border-line bg-white hover:border-brand-400 hover:bg-canvas',
                  )}
                >
                  <span className="flex items-center gap-2 pr-6 text-[15px] font-semibold text-ink">
                    <Icon
                      className={cn('h-4 w-4 shrink-0', active ? 'text-brand-600' : 'text-ink-3')}
                    />
                    {item.name}
                  </span>
                  <span className="mt-1.5 line-clamp-3 block text-[13px] leading-5 text-ink-3">
                    {item.detail}
                  </span>
                  {active && (
                    <span
                      aria-hidden="true"
                      className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-brand-600 text-white"
                    >
                      <Check className="h-3 w-3" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="grid min-w-0 gap-4 md:grid-cols-2">
            <Field
              label="归属评估任务（可选）"
              htmlFor="service-assurance-task"
              hint="默认不关联。需要纳入某个评估任务的汇总报告时再选择，也可在核验完成后关联。"
            >
              <Select
                id="service-assurance-task"
                value={selectedTaskId}
                onChange={(event) => onTaskChange(event.target.value)}
              >
                <option value="">不关联</option>
                {tasks.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="目标名称"
              htmlFor="service-assurance-target-name"
              hint="默认使用服务主机名或清单文件名，可修改。"
            >
              <Input
                id="service-assurance-target-name"
                value={targetName}
                maxLength={200}
                onChange={(event) => setTargetName(event.target.value)}
              />
            </Field>

            {!offline ? (
              <>
                <Field
                  label="目标类型"
                  htmlFor="service-assurance-target-kind"
                  hint={
                    <>
                      MCP 服务请使用
                      <Link
                        to="/ai-asset-scan"
                        className="font-medium text-primary hover:underline"
                      >
                        「AI 组件漏洞扫描」
                      </Link>
                      。
                    </>
                  }
                >
                  <Select
                    id="service-assurance-target-kind"
                    value={targetKind}
                    onChange={(event) => {
                      setTargetKind(event.target.value as 'ENDPOINT' | 'OPENAPI');
                      if (
                        event.target.value === 'OPENAPI' &&
                        targetUrl === lastAutoFilledTargetUrlRef.current
                      ) {
                        setTargetUrl('');
                      }
                    }}
                  >
                    <option value="ENDPOINT">普通 HTTP 服务</option>
                    <option value="OPENAPI">OpenAPI 描述文件</option>
                    <option value="MCP" disabled>
                      MCP 服务（专项检查暂未支持）
                    </option>
                  </Select>
                </Field>
                <Field
                  label="目标地址"
                  htmlFor="service-assurance-target-url"
                  className="min-w-0"
                  hint={
                    targetKind === 'OPENAPI'
                      ? '填写实际 OpenAPI JSON 或 YAML 文件地址，不是文档展示页面。'
                      : '填写要检查的 HTTP 服务地址，可包含接口路径。'
                  }
                >
                  <Input
                    id="service-assurance-target-url"
                    type="url"
                    inputMode="url"
                    placeholder={
                      targetKind === 'OPENAPI'
                        ? 'https://service.example.com/openapi.json'
                        : 'https://service.example.com/v1'
                    }
                    value={targetUrl}
                    onChange={(event) => setTargetUrl(event.target.value)}
                  />
                </Field>
              </>
            ) : (
              <Field
                label="组件清单文件"
                htmlFor="service-assurance-sbom"
                className="md:col-span-2"
              >
                <input
                  ref={sbomInputRef}
                  id="service-assurance-sbom"
                  type="file"
                  className="sr-only"
                  accept=".json,.spdx,application/json,application/vnd.cyclonedx+json,application/spdx+json,text/spdx"
                  aria-describedby="service-assurance-sbom-selection service-assurance-sbom-help"
                  onChange={(event) => selectSbomFile(event.target.files?.[0] ?? null)}
                />
                <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
                  <Button
                    type="button"
                    variant="outline"
                    className="w-fit max-w-full"
                    onClick={() => sbomInputRef.current?.click()}
                  >
                    <Upload className="h-4 w-4 shrink-0" />
                    选择组件清单
                  </Button>
                  <p
                    id="service-assurance-sbom-selection"
                    className="min-w-0 flex-1 break-all text-[13px] leading-5 text-ink-3"
                    aria-live="polite"
                  >
                    {sbomFile ? `已选择：${sbomFile.name}` : '尚未选择文件。'}
                  </p>
                </div>
                {sbomFileError ? (
                  <p role="alert" className="mt-1 text-sm text-red-700">
                    {sbomFileError}
                  </p>
                ) : (
                  <p
                    id="service-assurance-sbom-help"
                    className="mt-1 text-[13px] leading-5 text-ink-3"
                  >
                    支持 CycloneDX JSON、SPDX JSON 或 SPDX 文本，文件上限 2 MB。
                  </p>
                )}
              </Field>
            )}
          </div>

          <section aria-label="本次检查范围" className="rounded-card border border-line bg-canvas">
            <details className="group px-4 py-3 text-sm text-ink-2">
              <summary className="cursor-pointer select-none text-sm font-semibold text-ink">
                本次检查范围
                <span className="ml-2 text-[13px] font-normal text-ink-3">
                  共 {getServiceAssurancePlannedChecks(mode, offline ? 'SBOM' : targetKind).length}{' '}
                  项检查，点击查看
                </span>
              </summary>
              <ul className="mt-3 list-disc space-y-2 pl-5 leading-6">
                {getServiceAssurancePlannedChecks(mode, offline ? 'SBOM' : targetKind).map(
                  (check) => (
                    <li key={check.id}>
                      <span className="font-medium text-ink">{check.label}</span>：
                      {check.description}
                    </li>
                  ),
                )}
              </ul>
              <p className="mt-3 text-[13px] leading-5 text-ink-3">
                {offline
                  ? '组件清单在平台内部离线核验，不访问远程目标。'
                  : '访问身份：未携带凭据，不会沿用评估对象的模型密钥。'}
              </p>
              <div className="mt-2 space-y-1 text-[13px] leading-5 text-ink-3">
                {getServiceAssuranceLimitations(mode, offline ? 'SBOM' : targetKind).map(
                  (limitation) => (
                    <p key={limitation}>{limitation}</p>
                  ),
                )}
              </div>
            </details>
          </section>

          {!offline && (
            <>
              <div
                className={cn(
                  'rounded-card border px-4 py-3 text-sm leading-6',
                  targetAuthorized
                    ? 'border-severity-pass/30 bg-severity-pass-bg text-severity-pass'
                    : 'border-severity-medium/30 bg-severity-medium-bg text-severity-medium',
                )}
              >
                <p className="font-semibold">目标授权</p>
                <p>
                  {scopePolicies.length === 0
                    ? '尚未配置远程目标授权范围，当前不能发起在线核验。'
                    : targetAuthorized
                      ? `已匹配“${selectedPolicy?.name}”；执行时仍会校验解析地址和重定向。`
                      : !targetOrigin
                        ? '输入目标地址后自动匹配已保存的授权范围。'
                        : '当前目标尚未匹配授权范围，请由管理员先登记该目标。'}
                </p>
                {targetOriginMismatch && (
                  <p className="mt-1">该地址与所选任务的模型服务地址不一致；结果仍会记入该任务。</p>
                )}
                {!targetAuthorized && canManageScopes && (
                  <Link
                    to="/settings#service-assurance-scope"
                    className="mt-1 inline-block font-medium text-primary hover:underline"
                  >
                    前往平台设置配置授权范围 →
                  </Link>
                )}
              </div>
              {mode === 'DEEP' && (
                <div className="flex items-start gap-3 rounded-card bg-severity-medium-bg p-3 text-sm leading-6 text-severity-medium">
                  <input
                    id="service-assurance-authorization"
                    type="checkbox"
                    className="mt-1 h-4 w-4"
                    checked={authorizationConfirmed}
                    onChange={(event) => setAuthorizationConfirmed(event.target.checked)}
                  />
                  <div>
                    <label htmlFor="service-assurance-authorization" className="font-medium">
                      我确认已取得该目标的附加检查授权
                    </label>
                    <p className="text-[13px]">
                      {targetKind === 'OPENAPI'
                        ? '附加检查含管理状态接口和受控 API 主动检查，可能触发目标侧安全告警。'
                        : '附加检查含 /admin/status 的特定未授权响应检查，可能触发目标侧安全告警。'}
                    </p>
                  </div>
                </div>
              )}
              <details className="rounded-card border border-line px-4 py-3">
                <summary className="cursor-pointer text-sm font-semibold text-ink">
                  更多选项
                </summary>
                <div className="mt-4 space-y-4">
                  <Field
                    label="授权范围"
                    htmlFor="service-assurance-scope-policy"
                    hint="通常按目标地址自动匹配，仅在存在多个授权时调整。"
                  >
                    <Select
                      id="service-assurance-scope-policy"
                      value={scopePolicyRef}
                      onChange={(event) => setScopePolicyRef(event.target.value)}
                      disabled={scopePolicies.length === 0}
                    >
                      <option value="">请选择已保存的授权范围</option>
                      {scopePolicies.map((policy) => (
                        <option key={policy.ref} value={policy.ref}>
                          {policy.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              </details>
            </>
          )}

          <div
            aria-live="polite"
            className={cn(
              'rounded-card px-3 py-2 text-sm leading-6',
              ready ? 'bg-canvas text-ink-3' : 'bg-severity-medium-bg text-severity-medium',
            )}
          >
            {selectedReadiness?.message ?? '当前检查方式尚未确认可用，请刷新后重试。'}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line pt-4">
            {!permitted && (
              <span className="text-sm text-severity-medium">当前账号无权发起该检查。</span>
            )}
            <Button type="submit" disabled={!canSubmit}>
              <Check className="h-4 w-4" />
              {submitting ? '正在创建' : '发起核验'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
