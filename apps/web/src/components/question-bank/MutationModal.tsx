import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type MutationResult, type MutationStrategy } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Field } from '@/components/ui/field';

const MAX_STRATEGIES = 10;

/**
 * 样本库「变异扩展」：从种子库按种子随机抽样 → 选变换策略 → 产出新的自有样本库。
 * 变换只改变题面的表达形式，不改变分类、期望行为等元数据；同样的抽样数、种子、策略可以复现同一批题。
 */
export function MutationModal({
  open,
  onClose,
  setId,
  setName,
}: {
  open: boolean;
  onClose: () => void;
  setId: string;
  setName: string;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const strategiesQuery = useQuery({
    queryKey: ['question-set-mutation-strategies'],
    queryFn: () => api.questionSets.mutationStrategies(),
    enabled: open,
  });
  const [picked, setPicked] = useState<string[]>([]);
  const [sampleSize, setSampleSize] = useState(100);
  const [perSeed, setPerSeed] = useState(1);
  const [seed, setSeed] = useState('');
  const [newName, setNewName] = useState(`${setName} · 变异扩展`);
  const [result, setResult] = useState<MutationResult | null>(null);

  const items = strategiesQuery.data?.items ?? [];
  const llmConfigured = strategiesQuery.data?.llmConfigured ?? false;
  const maxOutput = strategiesQuery.data?.limits.maxOutput ?? 5000;
  const groups = useMemo(() => {
    const map = new Map<string, MutationStrategy[]>();
    for (const s of items) map.set(s.familyLabel, [...(map.get(s.familyLabel) ?? []), s]);
    return [...map];
  }, [items]);

  const effectivePerSeed = Math.min(perSeed, Math.max(picked.length, 1));
  const estimate = sampleSize * effectivePerSeed;
  const invalid =
    picked.length === 0 ||
    !newName.trim() ||
    !Number.isInteger(sampleSize) ||
    sampleSize < 1 ||
    sampleSize > 1000 ||
    !Number.isInteger(perSeed) ||
    perSeed < 1 ||
    perSeed > picked.length ||
    estimate > maxOutput;

  const toggle = (id: string) =>
    setPicked((cur) =>
      cur.includes(id)
        ? cur.filter((x) => x !== id)
        : cur.length >= MAX_STRATEGIES
          ? cur
          : [...cur, id],
    );

  const submit = useMutation({
    mutationFn: () =>
      api.questionSets.createMutation({
        sourceSetId: setId,
        sampleSize,
        seed: seed.trim() || undefined,
        strategies: picked,
        perSeed,
        name: newName.trim(),
      }),
    onSuccess: (r) => {
      setResult(r);
      toast.success(`已生成自有样本库「${r.name}」（${r.total} 题）`);
      void qc.invalidateQueries({ queryKey: ['question-sets'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '变异扩展失败'),
  });

  const close = () => {
    setResult(null);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      size="lg"
      title="变异扩展"
      description={`以「${setName}」为种子库：随机抽取若干题，套用所选变换策略，生成一个新的自有样本库。变换只改变表达形式，题目的分类与期望行为保持不变。`}
      footer={
        result ? (
          <div className="flex w-full justify-end">
            <Button onClick={close}>完成</Button>
          </div>
        ) : (
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <span className="text-sm" data-testid="estimate">
              预计产出：最多 {estimate} 题（{sampleSize} 个种子 × 每题 {effectivePerSeed} 种策略）
            </span>
            <div className="flex gap-2">
              <Button variant="outline" onClick={close}>
                取消
              </Button>
              <Button disabled={invalid || submit.isPending} onClick={() => submit.mutate()}>
                {submit.isPending ? '生成中…' : '生成新样本库'}
              </Button>
            </div>
          </div>
        )
      }
    >
      {result ? (
        <div className="space-y-3 text-sm" aria-label="生成结果">
          <p>
            新样本库「{result.name}」已生成：从 {result.sourceTotal} 题中抽取 {result.sampled}{' '}
            个种子，共产出 <b>{result.total}</b> 题
            {result.skipped > 0 ? `，另有 ${result.skipped} 题因不适用被跳过` : ''}。
          </p>
          <ul className="space-y-1">
            {result.perStrategy.map((s) => (
              <li key={s.id} className="flex justify-between border-b py-1">
                <span>{s.label}</span>
                <span>{s.count} 题</span>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground">
            复现凭据：种子 <code>{result.seed}</code>。相同的抽样数、种子与策略会得到同一批题。
            请在「自有样本库」中查看新库。
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="新样本库名称" required>
              <Input
                aria-label="新样本库名称"
                value={newName}
                maxLength={100}
                onChange={(e) => setNewName(e.target.value)}
              />
            </Field>
            <Field label="随机种子" hint="留空则自动生成，生成后会显示，用于复现同一批题">
              <Input
                aria-label="随机种子"
                value={seed}
                maxLength={64}
                onChange={(e) => setSeed(e.target.value)}
              />
            </Field>
            <Field label="抽样题数" hint="从种子库中随机抽取，1–1000">
              <Input
                aria-label="抽样题数"
                type="number"
                min={1}
                max={1000}
                value={sampleSize}
                onChange={(e) => setSampleSize(Number(e.target.value))}
              />
            </Field>
            <Field label="每题套用几种策略" hint="不能超过所选策略数">
              <Input
                aria-label="每题套用几种策略"
                type="number"
                min={1}
                max={MAX_STRATEGIES}
                value={perSeed}
                onChange={(e) => setPerSeed(Number(e.target.value))}
              />
            </Field>
          </div>

          <div>
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              变换策略
              <Badge tone="neutral">
                已选 {picked.length} / {MAX_STRATEGIES}
              </Badge>
            </div>
            {strategiesQuery.isLoading && <p className="text-sm">加载中…</p>}
            {strategiesQuery.isError && (
              <p className="text-sm text-destructive">策略列表加载失败，请稍后重试</p>
            )}
            <div className="max-h-[40vh] space-y-3 overflow-auto">
              {groups.map(([group, list]) => (
                <section key={group} aria-label={group} className="rounded-md border p-2">
                  <div className="mb-1 text-sm font-medium">{group}</div>
                  <ul className="grid gap-1 sm:grid-cols-2">
                    {list.map((s) => {
                      const disabled =
                        (s.requiresLlm && !llmConfigured) ||
                        (!picked.includes(s.id) && picked.length >= MAX_STRATEGIES);
                      return (
                        <li key={s.id}>
                          <label className="flex items-start gap-2 text-sm">
                            <input
                              type="checkbox"
                              aria-label={s.label}
                              checked={picked.includes(s.id)}
                              disabled={disabled}
                              onChange={() => toggle(s.id)}
                            />
                            <span>
                              {s.label}
                              <span className="block text-xs text-muted-foreground">
                                {s.requiresLlm && !llmConfigured
                                  ? '需先配置改写模型后才能使用'
                                  : s.description}
                              </span>
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

/**
 * 种子库卡片上的「变异扩展」入口（含弹窗）。
 * 用法：<MutationButton setId={set.id} setName={set.name} />
 */
export function MutationButton({ setId, setName }: { setId: string; setName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        变异扩展
      </Button>
      {open && (
        <MutationModal open onClose={() => setOpen(false)} setId={setId} setName={setName} />
      )}
    </>
  );
}
