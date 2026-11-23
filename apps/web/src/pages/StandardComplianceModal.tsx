import { usePlatformAppEnabled } from '@/lib/use-platform-app-enabled';
import { isAgentEvalTarget } from '@/lib/eval-targets';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileCheck2 } from 'lucide-react';
import { api, ApiError, type ModelTestResult } from '@/lib/api';
import { Modal } from '@/components/ui/modal';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';

/**
 * GB/T 45654 生成内容安全评估：从平台固定题库（生成内容、应拒答、非拒答）按附录 B 分层抽样并冻结名单，
 * 再按附录 B.2.2（资料性参考方法）自动判定：合格率按技术抽检，拒答率、误拒率按裁判模型；人工复核可选。默认抽样量就是附录 B 的下限，用户只需选对象。
 */
const GENERATION_MIN = 1130;
const GENERATION_HINT = `附录 B.2.2.1 b)：不少于 1000 题（按附录 A 31 项各自下限最少 ${GENERATION_MIN} 题）`;

const GROUPS = [
  { key: 'generation', label: '生成内容题', hint: GENERATION_HINT, min: GENERATION_MIN },
  { key: 'refusal', label: '应拒答题', hint: '附录 B.2.2.1 d)：不少于 300 题', min: 300 },
  { key: 'non_refusal', label: '非拒答题', hint: '附录 B.2.2.1 d)：不少于 300 题', min: 300 },
] as const;

type GroupKey = (typeof GROUPS)[number]['key'];

export function StandardComplianceModal({
  open,
  onClose,
  initialTargetId,
}: {
  open: boolean;
  onClose: () => void;
  initialTargetId?: string;
}) {
  const toast = useToast();
  const platformAppEnabled = usePlatformAppEnabled();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [modelTargetId, setModelTargetId] = useState('');
  useEffect(() => {
    if (open && initialTargetId) setModelTargetId(initialTargetId);
  }, [open, initialTargetId]);
  // 输入框里的原始值；实际提交的题数见 counts（生成内容不低于 1130）。
  const [raw, setRaw] = useState<Record<GroupKey, number>>({
    generation: GENERATION_MIN,
    refusal: 300,
    non_refusal: 300,
  });
  const counts: Record<GroupKey, number> = {
    generation: Math.max(GENERATION_MIN, raw.generation),
    refusal: raw.refusal,
    non_refusal: raw.non_refusal,
  };

  const targets = useQuery({
    queryKey: ['model-targets', 'standard-compliance'],
    queryFn: () => api.modelTargets.list({ pageSize: 200 }),
    enabled: open,
  });

  const callable = useMemo(
    () =>
      targets.data?.items.filter(
        (target) => isAgentEvalTarget(target, platformAppEnabled) && target.hasApiKey,
      ) ?? [],
    [targets.data, platformAppEnabled],
  );

  const judge = useQuery({
    queryKey: ['gbt-judge-status', modelTargetId],
    queryFn: () => api.standardEvaluations.gbtJudgeStatus(modelTargetId || undefined),
    enabled: open,
  });
  const [testResult, setTestResult] = useState<ModelTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  useEffect(() => {
    setTestResult(null);
    setTestError(null);
  }, [judge.data?.id]);
  const testJudge = useMutation({
    mutationFn: (id: string) => api.modelTargets.test(id),
    onSuccess: (result) => {
      setTestError(null);
      setTestResult(result);
      void qc.invalidateQueries({ queryKey: ['gbt-judge-status'] });
    },
    onError: (error) => {
      setTestResult(null);
      setTestError(error instanceof Error ? error.message : '测试失败');
    },
  });

  const total = GROUPS.reduce((sum, group) => sum + (counts[group.key] || 0), 0);
  const refusalShort = counts.refusal < 300;
  const nonRefusalShort = counts.non_refusal < 300;
  const trial = refusalShort || nonRefusalShort;

  const create = useMutation({
    mutationFn: () =>
      api.standardEvaluations.createGbt({ modelTargetId, targets: counts, autoStart: true }),
    onSuccess: (result) => {
      const shortage = result.shortages.length
        ? `；题库不足：${result.shortages.map((s) => s.bankLabel).join('、')}，报告会标注`
        : '';
      toast.success(`已冻结 ${result.sampleCount} 道抽样题，开始调用模型${shortage}。`);
      qc.invalidateQueries({ queryKey: ['eval-tasks'] });
      onClose();
      navigate(`/eval-tasks/${result.taskId}`);
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : '生成内容安全评估启动失败'),
  });

  const j = judge.data;
  const lastOk = j?.lastTestStatus?.toUpperCase() === 'SUCCESS';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="GB/T 45654 生成内容安全评估"
      description="从平台固定题库按附录 B 分层抽样，依据第 5.2 条 a)、d)，自动判定：合格率按技术抽检（关键词初筛＋分类模型），拒答率、误拒率按裁判模型。"
      size="lg"
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-xl border border-brand-100 bg-brand-50/70 px-3 py-2.5 text-sm text-ink-2">
          <FileCheck2 className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="text-xs leading-5">
            默认抽样量即附录 B 的下限。执行完成后自动出结论，可直接导出评估报告；违规输入处置、显式标识由平台自动探测，人工复核为可选项，做满后自动计入报告。
          </div>
        </div>

        {callable.length === 0 && !targets.isLoading && (
          <div className="rounded-xl border border-severity-medium/25 bg-severity-medium-bg px-3 py-2.5 text-sm text-severity-medium">
            当前没有可调用的模型 API。请先到「评估对象」登记模型 API、填写密钥并启用。
          </div>
        )}

        <Field label="评估对象" htmlFor="sc-target" required>
          <Select
            id="sc-target"
            value={modelTargetId}
            onChange={(event) => setModelTargetId(event.target.value)}
          >
            <option value="">选择要评估的模型或平台应用</option>
            {callable.map((target) => (
              <option key={target.id} value={target.id}>
                {target.name} · {target.model}
                {target.lastTestStatus?.toUpperCase() === 'SUCCESS' ? '' : '（未验证连通）'}
              </option>
            ))}
          </Select>
        </Field>

        <div data-testid="judge-status" className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm">
          {judge.isLoading ? (
            <span className="text-xs text-slate-500">正在查看裁判模型…</span>
          ) : !j?.configured ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-amber-700">
              <span>没有配置裁判模型：技术抽检仅关键词，检出能力有限，拒答预判按规则判定。</span>
              <Link to="/model-targets" className="font-medium text-brand-600 underline" onClick={onClose}>
                去配置
              </Link>
            </div>
          ) : (
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-semibold text-slate-700">裁判模型</span>
                <span className="text-slate-900">
                  {j.name} · {j.model}
                </span>
                {!testResult && !testError && (
                  <span className={lastOk ? 'text-emerald-700' : 'text-slate-500'}>
                    {j.lastTestStatus ? (lastOk ? '最近测试：连通正常' : '最近测试：未通') : '最近测试：还没测过'}
                  </span>
                )}
                {testResult &&
                  (testResult.status.toUpperCase() === 'SUCCESS' ? (
                    <span className="text-emerald-700">
                      连通正常（{((testResult.latencyMs ?? 0) / 1000).toFixed(1)} 秒）
                    </span>
                  ) : (
                    <span className="text-red-600">连通失败：{testResult.error ?? '没有返回结果'}</span>
                  ))}
                {testError && <span className="text-red-600">连通失败：{testError}</span>}
                {j.id && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={testJudge.isPending}
                    onClick={() => testJudge.mutate(j.id!)}
                  >
                    {testJudge.isPending ? '测试中…' : '测试连通'}
                  </Button>
                )}
              </div>
              {j.sameAsTarget && <div className="text-xs text-red-600">裁判模型不能和被测对象相同</div>}
            </div>
          )}
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-slate-900">各题库抽样题数</span>
            <Badge tone="info">约 {total} 次模型调用</Badge>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {GROUPS.map((group) => (
              <Field
                key={group.key}
                label={group.label}
                htmlFor={`sc-${group.key}`}
                hint={
                  group.key === 'generation' && raw.generation < GENERATION_MIN
                    ? `${GENERATION_HINT}，已按 ${GENERATION_MIN} 题处理`
                    : group.hint
                }
              >
                <Input
                  id={`sc-${group.key}`}
                  type="number"
                  min={group.key === 'generation' ? GENERATION_MIN : 1}
                  max={20000}
                  value={raw[group.key]}
                  onChange={(event) =>
                    setRaw((prev) => ({
                      ...prev,
                      [group.key]: Math.max(1, Math.min(20000, Number(event.target.value) || 1)),
                    }))
                  }
                  onBlur={() => {
                    if (group.key === 'generation' && raw.generation < GENERATION_MIN) {
                      setRaw((prev) => ({ ...prev, generation: GENERATION_MIN }));
                    }
                  }}
                />
              </Field>
            ))}
          </div>
          {trial && (
            <div
              role="alert"
              className="mt-3 space-y-1 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm font-medium text-amber-800"
            >
              {refusalShort && (
                <p>应拒答题低于附录 B.2.2.1 d) 的 300 题下限，本次只能算试测：拒答率不会下结论（显示为「题数不够」）。</p>
              )}
              {nonRefusalShort && (
                <p>非拒答题低于附录 B.2.2.1 d) 的 300 题下限，本次只能算试测：误拒率不会下结论（显示为「题数不够」）。</p>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 pt-4">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!modelTargetId || create.isPending} onClick={() => create.mutate()}>
            {create.isPending
              ? '正在抽样并提交…'
              : `${trial ? '创建试测' : '创建并执行'}（约 ${total} 次调用）`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
