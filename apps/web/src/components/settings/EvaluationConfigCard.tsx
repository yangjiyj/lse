import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save, SlidersHorizontal } from 'lucide-react';
import {
  DEFAULT_EVAL_WEIGHTS,
  EVAL_SCORE_COMPONENTS,
  EVAL_SCORE_COMPONENT_LABELS,
  EVAL_WEIGHT_DIMENSIONS,
  EVAL_WEIGHT_DIMENSION_LABELS,
  isWeightSum100,
} from '@lse/shared';
import { api, ApiError, type EvaluationSettings, type SystemSettings } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { LoadingBlock, Spinner } from '@/components/ui/spinner';
import { formatDateTime } from '@/lib/format';

const DEFAULT_FORM: EvaluationSettings = {
  dimensionWeights: { ...DEFAULT_EVAL_WEIGHTS.dimensionWeights },
  questionCount: 80,
  scoreWeights: { ...DEFAULT_EVAL_WEIGHTS.scoreWeights },
};

function sum(values: Record<string, number>): number {
  return Math.round(Object.values(values).reduce((a, b) => a + (Number(b) || 0), 0) * 100) / 100;
}

function SumHint({ values, label }: { values: Record<string, number>; label: string }) {
  const ok = isWeightSum100(values);
  return (
    <p className={ok ? 'text-xs text-severity-pass' : 'text-xs text-destructive'} role="status">
      {label}合计 {sum(values)}%{ok ? '' : '，须为 100%'}
    </p>
  );
}

/** 平台设置 →「配置管理」：支持配置评估维度权重占比、单次评估题数、评估分数权重占比。 */
export function EvaluationConfigCard({ canUpdate }: { canUpdate: boolean }) {
  const { success, error: toastError } = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['system-settings'],
    queryFn: () => api.systemSettings.get(),
  });
  const [form, setForm] = useState<EvaluationSettings>(DEFAULT_FORM);

  useEffect(() => {
    if (query.data?.evaluation) setForm(query.data.evaluation);
  }, [query.data]);

  const save = useMutation({
    mutationFn: () => api.systemSettings.update({ evaluation: form }),
    onSuccess: (res: SystemSettings) => {
      queryClient.setQueryData(['system-settings'], res);
      void queryClient.invalidateQueries({ queryKey: ['evaluation-config'] });
      if (res.evaluation) setForm(res.evaluation);
      success('配置管理已保存');
    },
    onError: (e) => toastError(e instanceof ApiError ? e.message : '保存失败'),
  });

  if (query.isLoading) return <LoadingBlock label="正在加载配置管理…" />;
  const valid =
    isWeightSum100(form.dimensionWeights) &&
    isWeightSum100(form.scoreWeights) &&
    form.questionCount >= 1 &&
    form.questionCount <= 2000;

  return (
    <Card id="evaluation-config" className="scroll-mt-5 rounded-none border-0 shadow-none">
      <CardHeader className="border-b border-line pb-4">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-5 w-5 text-primary" />
          <CardTitle>配置管理</CardTitle>
        </div>
        <p className="text-sm text-ink-3">
          支持配置评估维度权重占比、单次评估题数、评估分数权重占比
        </p>
      </CardHeader>
      <CardContent className="space-y-6 pt-5">
        {!canUpdate ? (
          <div className="rounded-md border border-amber-200 bg-severity-medium-bg px-3 py-2 text-sm text-severity-medium">
            当前账号没有权限修改配置管理，以下为只读展示。
          </div>
        ) : null}
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-ink">评估维度权重占比（%）</legend>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {EVAL_WEIGHT_DIMENSIONS.map((d) => (
              <Field key={d} label={EVAL_WEIGHT_DIMENSION_LABELS[d]} htmlFor={`eval-dim-${d}`}>
                <Input
                  id={`eval-dim-${d}`}
                  type="number"
                  min={0}
                  max={100}
                  value={form.dimensionWeights[d]}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      dimensionWeights: { ...form.dimensionWeights, [d]: Number(e.target.value) },
                    })
                  }
                  disabled={!canUpdate}
                />
              </Field>
            ))}
          </div>
          <SumHint values={form.dimensionWeights} label="评估维度权重占比" />
        </fieldset>
        <Field
          label="单次评估题数"
          htmlFor="eval-question-count"
          hint="发起内容安全评估（标准评估）时的默认样本数，1-2000"
          className="max-w-xs"
        >
          <Input
            id="eval-question-count"
            type="number"
            min={1}
            max={2000}
            value={form.questionCount}
            onChange={(e) => setForm({ ...form, questionCount: Number(e.target.value) })}
            disabled={!canUpdate}
          />
        </Field>
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-ink">评估分数权重占比（%）</legend>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {EVAL_SCORE_COMPONENTS.map((c) => (
              <Field key={c} label={EVAL_SCORE_COMPONENT_LABELS[c]} htmlFor={`eval-score-${c}`}>
                <Input
                  id={`eval-score-${c}`}
                  type="number"
                  min={0}
                  max={100}
                  value={form.scoreWeights[c]}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      scoreWeights: { ...form.scoreWeights, [c]: Number(e.target.value) },
                    })
                  }
                  disabled={!canUpdate}
                />
              </Field>
            ))}
          </div>
          <SumHint values={form.scoreWeights} label="评估分数权重占比" />
          <p className="text-xs leading-5 text-ink-3">
            综合评估得分 = Σ 各评估维度得分 × 维度权重；维度得分 = 通过率得分 × 通过率权重 +
            风险严重度得分 × 严重度权重。任务详情页展示“综合评估得分”。
          </p>
        </fieldset>
        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <Button
            aria-label="保存配置管理"
            onClick={() => save.mutate()}
            disabled={!canUpdate || save.isPending || !valid}
          >
            {save.isPending ? <Spinner className="h-4 w-4" /> : <Save className="h-4 w-4" />}
            保存配置
          </Button>
          {query.data?.updatedAt.evaluation ? (
            <span className="text-xs text-ink-3">
              最近更新：{formatDateTime(query.data.updatedAt.evaluation)}
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
