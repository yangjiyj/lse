import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type GateRuleInput, type GateRuleItem, type GateRules } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Field } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { Badge } from '@/components/ui/badge';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { LoadingBlock } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { RowActionMenu } from '@/components/page-kit/RowActionMenu';
import { useToast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/format';
import { CiExportButtons } from '@/components/CiExportButtons';

/** 规则摘要（中文），失败率按百分比展示。 */
export function describeGateRules(r: GateRules): string {
  const parts: string[] = [];
  if (r.minScore !== undefined) parts.push(`总体得分 ≥ ${r.minScore}`);
  if (r.maxHighRisk !== undefined) parts.push(`高风险数 ≤ ${r.maxHighRisk}`);
  for (const [c, v] of Object.entries(r.categoryMaxFailRate ?? {})) {
    parts.push(`${c}失败率 ≤ ${Math.round(v * 1000) / 10}%`);
  }
  if (r.noRegression) parts.push('相对上次不退化');
  return parts.join('；') || '—';
}

interface FormState {
  name: string;
  modelTargetId: string;
  planId: string;
  minScore: string;
  maxHighRisk: string;
  categories: string;
  noRegression: boolean;
  enabled: boolean;
}

function toForm(g?: GateRuleItem): FormState {
  const r = g?.rules ?? {};
  return {
    name: g?.name ?? '',
    modelTargetId: g?.modelTargetId ?? '',
    planId: g?.planId ?? '',
    minScore: r.minScore !== undefined ? String(r.minScore) : '',
    maxHighRisk: r.maxHighRisk !== undefined ? String(r.maxHighRisk) : '',
    categories: Object.entries(r.categoryMaxFailRate ?? {})
      .map(([c, v]) => `${c}=${Math.round(v * 1000) / 10}`)
      .join('\n'),
    noRegression: r.noRegression ?? false,
    enabled: g?.enabled ?? true,
  };
}

/** 表单 → 接口入参；类别门槛每行「类别=百分比」。返回错误信息字符串表示校验失败。 */
export function formToInput(f: FormState): GateRuleInput | string {
  if (!f.name.trim()) return '请填写门禁名称';
  if (!f.modelTargetId && !f.planId.trim()) return '请选择评估对象或评估计划';
  const rules: GateRules = {};
  if (f.minScore.trim()) {
    const v = Number(f.minScore);
    if (!Number.isFinite(v) || v < 0 || v > 100) return '总体得分门槛应在 0–100 之间';
    rules.minScore = v;
  }
  if (f.maxHighRisk.trim()) {
    const v = Number(f.maxHighRisk);
    if (!Number.isInteger(v) || v < 0) return '高风险数上限应为非负整数';
    rules.maxHighRisk = v;
  }
  const lines = f.categories
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length > 0) {
    const map: Record<string, number> = {};
    for (const line of lines) {
      const idx = line.lastIndexOf('=');
      const cat = idx > 0 ? line.slice(0, idx).trim() : '';
      const pct =
        idx > 0
          ? Number(
              line
                .slice(idx + 1)
                .trim()
                .replace(/%$/, ''),
            )
          : NaN;
      if (!cat || !Number.isFinite(pct) || pct < 0 || pct > 100) {
        return `类别门槛格式错误：${line}（应为「类别=百分比」）`;
      }
      map[cat] = Math.round(pct * 10) / 1000;
    }
    rules.categoryMaxFailRate = map;
  }
  if (f.noRegression) rules.noRegression = true;
  if (Object.keys(rules).length === 0) return '至少配置一条门禁条件';
  return {
    name: f.name.trim(),
    modelTargetId: f.modelTargetId || null,
    planId: f.planId.trim() || null,
    rules,
    enabled: f.enabled,
  };
}

function GateFormModal({
  gate,
  onClose,
}: {
  gate: GateRuleItem | null | undefined;
  onClose: () => void;
}) {
  const open = gate !== undefined;
  const [form, setForm] = useState<FormState>(() => toForm(gate ?? undefined));
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { success } = useToast();
  const targets = useQuery({
    queryKey: ['model-targets', 'gate-options'],
    queryFn: () => api.modelTargets.list({ page: 1, pageSize: 100 }),
    enabled: open,
  });
  const plans = useQuery({
    queryKey: ['eval-plans', 'gate-options'],
    queryFn: () => api.evalPlans.list({ page: 1, pageSize: 100 }),
    enabled: open,
  });
  const planOptions = plans.data?.items ?? [];
  // 已删除或不在前 100 条里的计划仍保留原值，避免编辑时静默清空。
  const planMissing = Boolean(form.planId) && !planOptions.some((p) => p.id === form.planId);
  const save = useMutation({
    mutationFn: (input: GateRuleInput) =>
      gate ? api.gates.update(gate.id, input) : api.gates.create(input),
    onSuccess: () => {
      success(gate ? '门禁已更新' : '门禁已创建');
      void queryClient.invalidateQueries({ queryKey: ['gates'] });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((p) => ({ ...p, [k]: v }));
  const submit = () => {
    const input = formToInput(form);
    if (typeof input === 'string') return setError(input);
    setError(null);
    save.mutate(input);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={gate ? '编辑门禁' : '新建门禁'}
      description="评估任务完成后，平台按启用的门禁自动判定并存档理由（平台评分，非认证结论）。"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={save.isPending} onClick={submit}>
            保存
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="门禁名称" htmlFor="gate-name" required className="sm:col-span-2">
          <Input
            id="gate-name"
            value={form.name}
            maxLength={120}
            onChange={(e) => set('name', e.target.value)}
          />
        </Field>
        <Field label="评估对象" htmlFor="gate-target">
          <Select
            id="gate-target"
            value={form.modelTargetId}
            onChange={(e) => set('modelTargetId', e.target.value)}
          >
            <option value="">不限</option>
            {(targets.data?.items ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="评估计划" htmlFor="gate-plan" hint="可选；选择后仅匹配该计划触发的任务">
          <Select
            id="gate-plan"
            value={form.planId}
            onChange={(e) => set('planId', e.target.value)}
          >
            <option value="">不限</option>
            {planOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            {planMissing && !plans.isLoading && (
              <option value={form.planId}>{`计划 ${form.planId}（未找到）`}</option>
            )}
          </Select>
        </Field>
        <Field label="总体得分不低于" htmlFor="gate-min-score" hint="0–100，留空不检查">
          <Input
            id="gate-min-score"
            inputMode="decimal"
            value={form.minScore}
            onChange={(e) => set('minScore', e.target.value)}
          />
        </Field>
        <Field label="高风险数不超过" htmlFor="gate-max-high" hint="留空不检查">
          <Input
            id="gate-max-high"
            inputMode="numeric"
            value={form.maxHighRisk}
            onChange={(e) => set('maxHighRisk', e.target.value)}
          />
        </Field>
        <Field
          label="类别失败率上限"
          htmlFor="gate-categories"
          hint="每行一条「类别=百分比」，类别名与题目分类一致，例如：隐私泄露=10"
          className="sm:col-span-2"
        >
          <textarea
            id="gate-categories"
            rows={3}
            className="rounded border border-line-2 px-2 py-1.5 text-sm"
            value={form.categories}
            onChange={(e) => set('categories', e.target.value)}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <input
            type="checkbox"
            checked={form.noRegression}
            onChange={(e) => set('noRegression', e.target.checked)}
          />
          相对上次运行不退化
        </label>
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => set('enabled', e.target.checked)}
          />
          启用
        </label>
        {error && <p className="text-sm text-severity-critical sm:col-span-2">{error}</p>}
      </div>
    </Modal>
  );
}

function LatestCell({ gate, canExport }: { gate: GateRuleItem; canExport: boolean }) {
  const l = gate.latest;
  if (!l) return <span className="text-ink-3">暂无判定</span>;
  return (
    <div className="flex flex-col gap-1">
      <span>
        <Badge icon tone={l.passed ? 'success' : 'danger'}>
          {l.passed ? '通过' : '不通过'}
        </Badge>
        <span className="ml-2 text-xs text-ink-3">{formatDateTime(l.createdAt)}</span>
      </span>
      {!l.passed && l.reasons.length > 0 && (
        <span className="text-xs text-severity-critical">{l.reasons.join('；')}</span>
      )}
      {l.sampleWarning && (
        <span className="text-xs text-severity-medium">
          样本量 {l.sampleSize ?? '—'}：{l.sampleWarning}
        </span>
      )}
      <a className="text-xs text-brand-600 hover:underline" href={`/eval-tasks/${l.taskId}`}>
        {l.taskName ?? '查看任务'}
      </a>
      {canExport && <CiExportButtons taskId={l.taskId} />}
    </div>
  );
}

function scopeText(g: GateRuleItem, planNames: Map<string, string>): string {
  const parts: string[] = [];
  if (g.modelTargetId) parts.push(`评估对象：${g.modelTargetName ?? g.modelTargetId}`);
  if (g.planId) parts.push(`评估计划：${planNames.get(g.planId) ?? g.planId}`);
  return parts.join('；');
}

/** 「接入流水线」要点（折叠）。完整示例见仓库 docs/ci-integration.md。 */
export function CiGuide() {
  return (
    <details
      className="mb-5 rounded-card border border-line bg-white px-5 py-3.5 shadow-card"
      data-testid="ci-guide"
    >
      <summary className="cursor-pointer text-sm font-semibold text-ink">
        接入流水线（CI/CD）
        <span className="ml-2 text-[13px] font-normal text-ink-3">令牌、脚本与退出码说明</span>
      </summary>
      <ol className="mt-3 list-decimal space-y-1.5 border-t border-line pt-3 pl-5 text-sm leading-6 text-ink-2">
        <li>
          管理员先在<Link to="/settings/api-tokens" className="text-brand-700 hover:underline">API 令牌</Link>页创建令牌，按最小权限勾选：触发计划选「触发评估计划」，读取门禁选「查询门禁判定」，导出报告选「导出评估任务结果」；令牌只显示一次，请存入
          CI 的密文变量（如 LSE_TOKEN），不要打印到日志。
        </li>
        <li>
          用命令行脚本 scripts/lse-ci.mjs（Node 18+，零依赖）：run --plan 计划ID --wait
          触发并等待，gate --task 任务ID 读取门禁，export --task 任务ID --format junit|sarif|json
          --out 文件 导出结果；通过环境变量 LSE_URL、LSE_TOKEN 指定地址与令牌。
        </li>
        <li>
          退出码：0 门禁通过；1 门禁未通过（流水线应失败）；2 评估执行失败、被跳过或等待超时；3
          用法或认证错误。
        </li>
        <li>
          JUnit 可在 GitHub Actions、GitLab CI、Jenkins 的测试报告页展示；SARIF
          可上传到代码扫描页；JSON 适合二次处理。导出不含模型完整回答，判定摘要已脱敏并截断。
        </li>
        <li>
          评估会消耗模型调用额度且耗时较长，建议用抽样或夜间计划，并设置合理的等待超时；私有化环境使用自签证书时，请设置
          NODE_EXTRA_CA_CERTS 指向 CA 文件，不要关闭证书校验。
        </li>
        <li>门禁结论是平台评分，不是认证结论。</li>
      </ol>
    </details>
  );
}

export function GatesPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('gate:manage');
  const canRead = canManage || hasPermission('gate:read');
  const queryClient = useQueryClient();
  const { success, error: toastError } = useToast();
  // undefined = 关闭；null = 新建；对象 = 编辑
  const [editing, setEditing] = useState<GateRuleItem | null | undefined>(undefined);
  const { data, isLoading, error } = useQuery({
    queryKey: ['gates'],
    queryFn: () => api.gates.list(),
    enabled: canRead,
  });
  const hasPlanGates = (data?.items ?? []).some((g) => g.planId);
  const planList = useQuery({
    queryKey: ['eval-plans', 'gate-names'],
    queryFn: () => api.evalPlans.list({ page: 1, pageSize: 100 }),
    enabled: canRead && hasPlanGates && hasPermission('eval_task:read'),
  });
  const planNames = new Map((planList.data?.items ?? []).map((p) => [p.id, p.name]));
  const remove = useMutation({
    mutationFn: (id: string) => api.gates.remove(id),
    onSuccess: () => {
      success('门禁已删除');
      void queryClient.invalidateQueries({ queryKey: ['gates'] });
    },
    onError: (e: Error) => toastError(e.message),
  });

  if (!canRead) {
    return (
      <div>
        <PageHeader title="上线门禁" />
        <EmptyState title="缺少查看上线门禁的权限" />
      </div>
    );
  }
  const items = data?.items ?? [];
  return (
    <div>
      <PageHeader
        title="上线门禁"
        description="评估任务完成后自动按规则判定通过/不通过；CI 可用 API 令牌查询最新判定。门禁结论为平台评分，非认证结论。"
        actions={canManage ? <Button onClick={() => setEditing(null)}>新建门禁</Button> : undefined}
      />
      <CiGuide />
      <div>
        {isLoading ? (
          <LoadingBlock />
        ) : error ? (
          <p className="p-4 text-sm text-severity-critical">{(error as Error).message}</p>
        ) : items.length === 0 ? (
          <EmptyState title="暂无数据" description="还没有配置上线门禁。" />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>门禁名称</TH>
                <TH>适用范围</TH>
                <TH>规则</TH>
                <TH>状态</TH>
                <TH>最新判定</TH>
                <TH>门禁 ID</TH>
                {canManage && <TH>操作</TH>}
              </TR>
            </THead>
            <TBody>
              {items.map((g) => (
                <TR key={g.id} className="h-10">
                  <TD data-label="门禁名称">{g.name}</TD>
                  <TD data-label="适用范围">{scopeText(g, planNames)}</TD>
                  <TD data-label="规则" className="max-w-xs">
                    {describeGateRules(g.rules)}
                  </TD>
                  <TD data-label="状态">
                    <Badge tone={g.enabled ? 'success' : 'neutral'}>
                      {g.enabled ? '启用' : '停用'}
                    </Badge>
                  </TD>
                  <TD data-label="最新判定" className="py-3">
                    <LatestCell gate={g} canExport={hasPermission('eval_task:read')} />
                  </TD>
                  <TD data-label="门禁 ID" className="font-mono text-xs text-ink-3">
                    {g.id}
                  </TD>
                  {canManage && (
                    <TD data-label="操作" className="whitespace-nowrap">
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          className="text-sm text-brand-600 hover:underline"
                          onClick={() => setEditing(g)}
                        >
                          编辑
                        </button>
                        <RowActionMenu
                          items={[
                            {
                              key: 'delete',
                              label: '删除',
                              danger: true,
                              disabled: remove.isPending,
                              onSelect: () => {
                                if (
                                  window.confirm(
                                    `确认删除门禁「${g.name}」？历史判定记录将一并删除。`,
                                  )
                                ) {
                                  remove.mutate(g.id);
                                }
                              },
                            },
                          ]}
                        />
                      </div>
                    </TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </div>
      {editing !== undefined && (
        <GateFormModal
          key={editing?.id ?? 'new'}
          gate={editing}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  );
}
