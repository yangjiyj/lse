import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe2, Plus, Save, ShieldCheck, Trash2 } from 'lucide-react';
import {
  api,
  ApiError,
  type ServiceAssuranceScopePolicy,
  type ServiceAssuranceScopePreview,
} from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { LoadingBlock, Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

function policyRef(hostname: string, existing: ServiceAssuranceScopePolicy[]): string {
  const base = `target-${hostname
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .slice(0, 100)}`;
  if (!existing.some((item) => item.ref === base)) return base;
  let suffix = 2;
  while (existing.some((item) => item.ref === `${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function ScopePolicySettingsCard({
  canUpdate,
  className,
}: {
  canUpdate: boolean;
  className?: string;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [targetUrl, setTargetUrl] = useState('');
  const [targetName, setTargetName] = useState('');
  const [preview, setPreview] = useState<ServiceAssuranceScopePreview | null>(null);
  const [policies, setPolicies] = useState<ServiceAssuranceScopePolicy[]>([]);
  const [dirty, setDirty] = useState(false);

  const query = useQuery({
    queryKey: ['service-assurance', 'scope-policies'],
    queryFn: () => api.serviceAssurance.scopePolicies(),
  });

  useEffect(() => {
    if (!query.data || dirty) return;
    setPolicies(query.data.policies);
  }, [dirty, query.data]);

  const previewMutation = useMutation({
    mutationFn: () => api.serviceAssurance.previewScopePolicy(targetUrl.trim()),
    onSuccess: (result) => {
      setPreview(result);
      if (!targetName.trim()) setTargetName(result.hostname);
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : '目标地址解析失败。'),
  });

  const saveMutation = useMutation({
    mutationFn: () => api.serviceAssurance.saveScopePolicies(policies),
    onSuccess: (result) => {
      setPolicies(result.policies);
      setDirty(false);
      queryClient.setQueryData(['service-assurance', 'scope-policies'], result);
      toast.success('服务核验授权范围已保存。');
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : '授权范围保存失败。'),
  });

  const addPreview = () => {
    if (!preview) return;
    const item: ServiceAssuranceScopePolicy = {
      ref: policyRef(preview.hostname, policies),
      name: targetName.trim() || preview.hostname,
      origins: [preview.origin],
      cidrs: preview.suggestedCidrs,
      allowPrivate: preview.allowPrivate,
      allowPublic: preview.allowPublic,
      isDefault: policies.length === 0,
    };
    setPolicies((current) => [...current, item]);
    setDirty(true);
    setPreview(null);
    setTargetUrl('');
    setTargetName('');
  };

  const setDefault = (ref: string) => {
    setPolicies((current) => current.map((item) => ({ ...item, isDefault: item.ref === ref })));
    setDirty(true);
  };

  const removePolicy = (ref: string) => {
    setPolicies((current) => {
      const filtered = current.filter((item) => item.ref !== ref);
      const needsDefault = filtered.length > 0 && !filtered.some((item) => item.isDefault);
      return filtered.map((item, index) => ({
        ...item,
        isDefault: needsDefault ? index === 0 : item.isDefault,
      }));
    });
    setDirty(true);
  };

  return (
    <Card id="service-assurance-scope" className={cn('scroll-mt-5', className)}>
      <CardHeader className="border-b border-line pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
          <CardTitle>服务核验授权范围</CardTitle>
          <Badge tone={!dirty && policies.length > 0 ? 'success' : 'warning'}>
            {dirty
              ? '有未保存的变更'
              : policies.length > 0
                ? `已授权 ${policies.length} 个目标`
                : '待配置'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-5">
        {dirty && (
          <p
            role="status"
            className="rounded-md bg-severity-medium-bg px-3 py-2 text-sm text-severity-medium"
          >
            变更尚未生效，点击“保存授权范围”后才能用于核验。
          </p>
        )}
        <p className="text-sm leading-6 text-ink-3">
          远程安全核验只访问这里登记的目标。平台会固定核对域名、解析地址和网络范围，防止扫描未授权服务。
        </p>
        {!canUpdate ? (
          <div className="rounded-md border border-amber-200 bg-severity-medium-bg px-3 py-2 text-sm text-severity-medium">
            当前账号只能查看授权范围，不能新增或修改。
          </div>
        ) : (
          <div className="rounded-md border border-line bg-canvas p-4">
            <div className="grid gap-4 md:grid-cols-2">
              <Field
                label="目标地址"
                htmlFor="scope-target-url"
                hint="可填写具体接口路径；授权时会自动归一化为协议、域名和端口。"
              >
                <Input
                  id="scope-target-url"
                  type="url"
                  value={targetUrl}
                  onChange={(event) => {
                    setTargetUrl(event.target.value);
                    setPreview(null);
                  }}
                  placeholder="https://api.example.com/v1"
                  className="font-mono text-xs"
                />
              </Field>
              <Field label="授权名称" htmlFor="scope-target-name">
                <Input
                  id="scope-target-name"
                  value={targetName}
                  onChange={(event) => setTargetName(event.target.value)}
                  placeholder="例如：生产模型 API"
                />
              </Field>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => previewMutation.mutate()}
                disabled={!targetUrl.trim() || previewMutation.isPending}
              >
                {previewMutation.isPending ? (
                  <Spinner className="h-4 w-4" />
                ) : (
                  <Globe2 className="h-4 w-4" />
                )}
                解析并检查
              </Button>
              {preview ? (
                <Button type="button" onClick={addPreview}>
                  <Plus className="h-4 w-4" />
                  加入待保存范围
                </Button>
              ) : null}
            </div>
            {preview ? (
              <div className="mt-3 rounded-md border border-emerald-200 bg-severity-pass-bg px-3 py-2 text-xs leading-6 text-severity-pass">
                <div>授权源：{preview.origin}</div>
                <div className="break-all">解析地址：{preview.addresses.join('、')}</div>
                <div>
                  网络类型：
                  {[preview.allowPublic ? '公网' : '', preview.allowPrivate ? '内网' : '']
                    .filter(Boolean)
                    .join('、')}
                </div>
              </div>
            ) : null}
          </div>
        )}

        {query.isLoading ? (
          <LoadingBlock label="正在加载授权范围" />
        ) : policies.length === 0 ? (
          <div className="rounded-md border border-amber-200 bg-severity-medium-bg px-4 py-3 text-sm leading-6 text-severity-medium">
            尚未授权任何远程目标。安全检查和深度核验将保持禁用；组件清单核验不受影响。
          </div>
        ) : (
          <div className="space-y-3">
            {policies.map((policy) => (
              <div key={policy.ref} className="rounded-md border border-line px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink">{policy.name}</span>
                      {policy.isDefault ? <Badge tone="success">默认</Badge> : null}
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-ink-3">
                      {policy.origins.join('、')}
                    </div>
                    <div className="mt-1 break-all text-xs text-ink-3">
                      地址范围：{policy.cidrs.join('、')}
                    </div>
                  </div>
                  {canUpdate ? (
                    <div className="flex shrink-0 gap-2">
                      {!policy.isDefault ? (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setDefault(policy.ref)}
                        >
                          设为默认
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        aria-label={`删除授权 ${policy.name}`}
                        onClick={() => removePolicy(policy.ref)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}

        {canUpdate ? (
          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
            <Button
              type="button"
              onClick={() => saveMutation.mutate()}
              disabled={!dirty || saveMutation.isPending}
            >
              {saveMutation.isPending ? (
                <Spinner className="h-4 w-4" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              保存授权范围
            </Button>
            {!query.data?.managedByPlatform && policies.length > 0 ? (
              <span className="text-xs text-severity-high">
                当前显示部署配置；保存后转为平台管理。
              </span>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
