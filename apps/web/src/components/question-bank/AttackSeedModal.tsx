import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type AttackSeedResult, type AttackSeedSpec } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Field } from '@/components/ui/field';
import { AttackSeedForm } from './AttackSeedForm';

const INITIAL: AttackSeedSpec = {
  domain: '',
  scope: '',
  focus: '',
  keywords: [],
  scenarioCount: 5,
  questionsPerScenario: 5,
  binding: null,
};

/** 样本库「攻击种子泛化」：填写表单 → 批量生成 → 按场景分组预览（勾选/删除单题）→ 保存为自有题库。 */
export function AttackSeedModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [spec, setSpec] = useState<AttackSeedSpec>(INITIAL);
  const [result, setResult] = useState<AttackSeedResult | null>(null);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const key = (si: number, qi: number) => `${si}:${qi}`;

  const generate = useMutation({
    mutationFn: () => api.questionSets.generateAttackSeeds(spec),
    onSuccess: (r) => {
      setResult(r);
      setRemoved(new Set());
      setUnchecked(new Set());
      if (!name) setName(`攻击种子 · ${spec.domain}`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '生成失败'),
  });
  const kept = (result?.scenarios ?? []).map((s, si) => ({
    ...s,
    questions: s.questions.filter(
      (_, qi) => !removed.has(key(si, qi)) && !unchecked.has(key(si, qi)),
    ),
  }));
  const keptTotal = kept.reduce((a, s) => a + s.questions.length, 0);
  const save = useMutation({
    mutationFn: () =>
      api.questionSets.saveAttackSeeds({
        name: name.trim(),
        spec,
        source: result!.source,
        scenarios: kept.filter((s) => s.questions.length > 0),
      }),
    onSuccess: (r) => {
      toast.success(`已保存为自有题库「${r.name}」（${r.questionCount} 题）`);
      void qc.invalidateQueries({ queryKey: ['question-sets'] });
      void qc.invalidateQueries({ queryKey: ['attack-seed-domains'] });
      setResult(null);
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '保存失败'),
  });
  const toggle = (set: Set<string>, k: string) => {
    const next = new Set(set);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    return next;
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title="攻击种子泛化"
      description="面向实战攻防的测试场景与种子问题智能生成：根据测试范围、重点关注方向和参考关键词自动生成场景及对应问题。"
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <span className="text-sm" data-testid="estimate">
            预计生成规模：{spec.scenarioCount} 个场景 × {spec.questionsPerScenario} 题 ={' '}
            {spec.scenarioCount * spec.questionsPerScenario} 题
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={!spec.domain.trim() || generate.isPending}
              onClick={() => generate.mutate()}
            >
              {generate.isPending ? '生成中…' : '批量生成'}
            </Button>
            <Button
              disabled={!result || keptTotal === 0 || !name.trim() || save.isPending}
              onClick={() => save.mutate()}
            >
              保存为自有题库
            </Button>
          </div>
        </div>
      }
    >
      <AttackSeedForm spec={spec} onChange={setSpec} />
      {result && (
        <div className="mt-4 space-y-3" aria-label="结果预览">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">结果预览</span>
            {result.source === 'attacker_model' ? (
              <Badge tone="success">
                攻击模型生成{result.attackerModel ? `（${result.attackerModel}）` : ''}
              </Badge>
            ) : (
              <Badge tone="warning">
                模板生成{result.fallbackReason ? `：${result.fallbackReason}` : ''}
              </Badge>
            )}
            <span className="text-muted-foreground">已选 {keptTotal} 题</span>
          </div>
          <Field label="题库名称">
            <Input aria-label="题库名称" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="max-h-[45vh] space-y-3 overflow-auto">
            {result.scenarios.map((s, si) => (
              <section key={si} className="rounded-md border p-2" aria-label={s.name}>
                <div className="text-sm font-medium">{s.name}</div>
                {s.description && (
                  <div className="text-xs text-muted-foreground">{s.description}</div>
                )}
                <ul className="mt-1 space-y-1 text-sm">
                  {s.questions.map((q, qi) =>
                    removed.has(key(si, qi)) ? null : (
                      <li key={qi} className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          aria-label={`选择：${q}`}
                          checked={!unchecked.has(key(si, qi))}
                          onChange={() => setUnchecked((u) => toggle(u, key(si, qi)))}
                        />
                        <span className="flex-1 break-words">{q}</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`删除：${q}`}
                          onClick={() => setRemoved((r) => toggle(r, key(si, qi)))}
                        >
                          删除
                        </Button>
                      </li>
                    ),
                  )}
                </ul>
              </section>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
