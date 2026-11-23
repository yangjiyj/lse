import { usePlatformAppEnabled } from '@/lib/use-platform-app-enabled';
import { isAgentEvalTarget } from '@/lib/eval-targets';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FileUp,
  Fish,
  ListChecks,
  PlayCircle,
  ShieldAlert,
  ShieldCheck,
  Shuffle,
  Swords,
} from 'lucide-react';
import { api, ApiError, type ComprehensiveEvalModuleId, type ModelTarget } from '@/lib/api';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';

interface ComprehensiveEvalModalProps {
  initialTargetId?: string;
  open: boolean;
  onClose: () => void;
}

const DEFAULT_MODULES: ComprehensiveEvalModuleId[] = [
  'content_safety',
  'autonomous_red_team',
  'agent_tool_safety',
  'indirect_prompt_injection',
];

type CountModuleId =
  | 'content_safety'
  | 'autonomous_red_team'
  | 'agent_tool_safety'
  | 'indirect_prompt_injection';

const SAMPLE_COUNT_PRESETS: Record<'full' | 'random', Record<CountModuleId, number>> = {
  full: {
    content_safety: 120,
    autonomous_red_team: 24,
    agent_tool_safety: 36,
    indirect_prompt_injection: 24,
  },
  random: {
    content_safety: 36,
    autonomous_red_team: 4,
    agent_tool_safety: 12,
    indirect_prompt_injection: 12,
  },
};

const COUNT_MODULES: Array<{ id: CountModuleId; label: string }> = [
  { id: 'content_safety', label: '内容安全样本数' },
  { id: 'autonomous_red_team', label: '自主红队场景数' },
  { id: 'agent_tool_safety', label: '智能体工具安全样本数' },
  { id: 'indirect_prompt_injection', label: '间接提示注入样本数' },
];

function countLimits(id: CountModuleId, mode: 'full' | 'random') {
  if (id === 'content_safety') return { min: 1, max: 2000 };
  if (id === 'autonomous_red_team') return { min: 1, max: 200 };
  return mode === 'full' ? { min: 24, max: 120 } : { min: 12, max: 60 };
}

function presetCountStrings(mode: 'full' | 'random'): Record<CountModuleId, string> {
  return Object.fromEntries(
    Object.entries(SAMPLE_COUNT_PRESETS[mode]).map(([id, count]) => [id, String(count)]),
  ) as Record<CountModuleId, string>;
}

const MODULES = [
  {
    id: 'content_safety',
    label: '内容安全评估',
    description: '合规、拒答、敏感信息、提示注入、幻觉与模型安全。',
    Icon: ShieldAlert,
  },
  {
    id: 'autonomous_red_team',
    label: '自主红队评估',
    description: '攻击模型按响应逐轮调整策略，保留完整对抗证据。',
    Icon: Swords,
  },
  {
    id: 'agent_tool_safety',
    label: '智能体工具安全评估',
    description: '工具越权、敏感文件、危险命令、内网访问与数据外传。',
    Icon: ShieldCheck,
  },
  {
    id: 'indirect_prompt_injection',
    label: '间接提示注入评估',
    description: '验证网页、文档和结构化数据中的投毒指令是否被执行。',
    Icon: Fish,
  },
  {
    id: 'sample_regression',
    label: '样本库回归评估',
    description: '把现有基线或整改样本纳入同一任务；需要选择样本库。',
    Icon: ListChecks,
  },
  {
    id: 'runtime_trace',
    label: '运行轨迹导入分析',
    description: '把 ADR-compatible JSON 的脱敏离线分析结果并入本次报告。',
    Icon: FileUp,
  },
] satisfies Array<{
  id: ComprehensiveEvalModuleId;
  label: string;
  description: string;
  Icon: typeof ShieldAlert;
}>;

function executableTarget(target: ModelTarget, platformAppEnabled = false): boolean {
  return isAgentEvalTarget(target, platformAppEnabled);
}

function optionLabel(target: ModelTarget): string {
  return `${target.name}（${target.model}）`;
}

export function ComprehensiveEvalModal({
  open,
  onClose,
  initialTargetId,
}: ComprehensiveEvalModalProps) {
  const platformAppEnabled = usePlatformAppEnabled();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [modelTargetId, setModelTargetId] = useState('');
  useEffect(() => {
    if (open && initialTargetId) setModelTargetId(initialTargetId);
  }, [open, initialTargetId]);
  const [mode, setMode] = useState<'full' | 'random'>('full');
  const [sampleCounts, setSampleCounts] = useState<Record<CountModuleId, string>>(
    presetCountStrings('full'),
  );
  const [seed, setSeed] = useState('');
  const [concurrency, setConcurrency] = useState('4');
  const [modules, setModules] = useState<ComprehensiveEvalModuleId[]>(DEFAULT_MODULES);
  const [regressionQuestionSetIds, setRegressionQuestionSetIds] = useState<string[]>([]);
  const [adrPayload, setAdrPayload] = useState<unknown>();
  const [adrFilename, setAdrFilename] = useState('');

  const targets = useQuery({
    queryKey: ['model-targets', 'comprehensive-eval'],
    queryFn: () => api.modelTargets.list({ page: 1, pageSize: 200, includeSystem: true }),
    enabled: open,
  });
  const questionSets = useQuery({
    queryKey: ['question-sets', 'comprehensive-eval'],
    queryFn: () => api.questionSets.list({ page: 1, pageSize: 100, enabled: true }),
    enabled: open && modules.includes('sample_regression'),
  });

  const hasJudge = useMemo(
    () =>
      targets.data?.items.some((target) => target.isActive && target.targetType === 'JUDGE') ??
      false,
    [targets.data?.items],
  );
  const executableTargets = useMemo(
    () =>
      targets.data?.items.filter((target) => executableTarget(target, platformAppEnabled)) ?? [],
    [targets.data?.items, platformAppEnabled],
  );
  const selectedTarget = useMemo(
    () => executableTargets.find((target) => target.id === modelTargetId) ?? null,
    [executableTargets, modelTargetId],
  );

  useEffect(() => {
    if (!open || modelTargetId || executableTargets.length !== 1) return;
    setModelTargetId(executableTargets[0]!.id);
  }, [executableTargets, modelTargetId, open]);

  useEffect(() => {
    if (open) return;
    setModelTargetId('');
    setMode('full');
    setSampleCounts(presetCountStrings('full'));
    setSeed('');
    setConcurrency('4');
    setModules(DEFAULT_MODULES);
    setRegressionQuestionSetIds([]);
    setAdrPayload(undefined);
    setAdrFilename('');
  }, [open]);

  const selectMode = (nextMode: 'full' | 'random') => {
    setMode(nextMode);
    setSampleCounts(presetCountStrings(nextMode));
  };

  const toggleModule = (id: ComprehensiveEvalModuleId) => {
    setModules((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  };

  const toggleRegressionSet = (id: string) => {
    setRegressionQuestionSetIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  };

  const readAdrFile = async (file: File | undefined) => {
    if (!file) {
      setAdrPayload(undefined);
      setAdrFilename('');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error('轨迹文件不能超过 10 MB。');
      return;
    }
    try {
      const payload = JSON.parse(await file.text()) as unknown;
      setAdrPayload(payload);
      setAdrFilename(file.name);
      if (!modules.includes('runtime_trace'))
        setModules((current) => [...current, 'runtime_trace']);
    } catch {
      toast.error('轨迹文件不是有效 JSON，请重新选择。');
    }
  };

  const run = useMutation({
    mutationFn: () => {
      const activeSampleCounts = Object.fromEntries(
        COUNT_MODULES.filter(({ id }) => modules.includes(id)).map(({ id }) => [
          id,
          Number(sampleCounts[id]),
        ]),
      ) as Partial<Record<CountModuleId, number>>;
      return api.evalTasks.createComprehensive({
        modelTargetId,
        mode,
        modules,
        sampleCounts: activeSampleCounts,
        concurrency: Math.max(1, Math.min(16, Number(concurrency) || 4)),
        ...(seed.trim() ? { seed: seed.trim() } : {}),
        ...(modules.includes('sample_regression') ? { regressionQuestionSetIds } : {}),
        ...(modules.includes('runtime_trace') ? { adrPayload } : {}),
      });
    },
    onSuccess: (task) => {
      toast.success('综合评估已开始，所有模块将在同一任务中随机混排执行');
      qc.invalidateQueries({ queryKey: ['eval-tasks'] });
      onClose();
      navigate(`/eval-tasks/${task.id}`);
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : '综合评估启动失败'),
  });

  const redTeamReady = !modules.includes('autonomous_red_team') || hasJudge;
  const regressionReady =
    !modules.includes('sample_regression') || regressionQuestionSetIds.length > 0;
  const adrReady = !modules.includes('runtime_trace') || adrPayload !== undefined;
  const countsReady = COUNT_MODULES.filter(({ id }) => modules.includes(id)).every(({ id }) => {
    const count = Number(sampleCounts[id]);
    const limits = countLimits(id, mode);
    return Number.isInteger(count) && count >= limits.min && count <= limits.max;
  });
  const plannedSampleCount = COUNT_MODULES.filter(({ id }) => modules.includes(id)).reduce(
    (sum, { id }) => sum + (Number(sampleCounts[id]) || 0),
    0,
  );
  const canSubmit = Boolean(
    selectedTarget &&
    modules.length > 0 &&
    countsReady &&
    redTeamReady &&
    regressionReady &&
    adrReady &&
    !run.isPending,
  );
  const blockingReason = targets.isLoading
    ? '正在加载评估对象…'
    : targets.isError
      ? '评估对象加载失败，请关闭后重试'
      : executableTargets.length === 0
        ? '没有可用的模型评估对象，请先到评估对象页面创建并启用'
        : !selectedTarget
          ? '请先在表单顶部选择评估对象'
          : modules.length === 0
            ? '请至少选择一个评估模块'
            : !countsReady
              ? '请检查样本数量是否在允许范围内'
              : !redTeamReady
                ? '自主红队需要先配置独立判定模型'
                : !regressionReady
                  ? '请选择至少一个回归样本库'
                  : !adrReady
                    ? '请上传 ADR-compatible 运行轨迹'
                    : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="发起综合安全评估"
      description="一次创建一个任务，随机混排执行多类测试；进度、证据、整改和报告统一汇总。"
      size="xl"
      footer={
        <>
          {blockingReason && (
            <span className="mr-auto self-center text-sm text-amber-700">{blockingReason}</span>
          )}
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!canSubmit} onClick={() => run.mutate()}>
            {run.isPending ? <Spinner className="h-4 w-4" /> : <PlayCircle className="h-4 w-4" />}
            创建并执行
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="flex gap-2 rounded-xl border border-brand-100 bg-brand-50/70 px-3 py-2.5 text-sm leading-6 text-ink-2">
          <Shuffle className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
          <div>
            所选模块会进入同一个任务，并按 seed
            可复现地随机混排。报告将给出各模块样本数、通过、风险和异常统计，同时保留专项证据章节。
          </div>
        </div>

        <Field label="评估对象" htmlFor="comprehensive-target" required>
          <Select
            id="comprehensive-target"
            aria-label="评估对象"
            value={modelTargetId}
            onChange={(event) => setModelTargetId(event.target.value)}
          >
            <option value="">请选择评估对象…</option>
            {executableTargets.map((target) => (
              <option key={target.id} value={target.id}>
                {optionLabel(target)}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="测试方式" required>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="测试方式">
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'full'}
              onClick={() => selectMode('full')}
              className={`rounded-xl border p-3 text-left ${mode === 'full' ? 'border-primary bg-primary/5 ring-1 ring-primary/20' : 'border-border'}`}
            >
              <div className="text-sm font-semibold">全量能力覆盖</div>
              <div className="mt-1 text-xs leading-5 text-muted-foreground">
                覆盖全部已选能力模块并使用较大样本预算；不是无限穷举。
              </div>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'random'}
              onClick={() => selectMode('random')}
              className={`rounded-xl border p-3 text-left ${mode === 'random' ? 'border-primary bg-primary/5 ring-1 ring-primary/20' : 'border-border'}`}
            >
              <div className="text-sm font-semibold">随机抽样验证</div>
              <div className="mt-1 text-xs leading-5 text-muted-foreground">
                使用较小样本预算快速发现明显问题，适合日常巡检。
              </div>
            </button>
          </div>
        </Field>

        <Field
          label="评估模块"
          required
          hint="默认选择四个可自动执行的核心模块；轨迹和回归样本按需附加。"
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {MODULES.map(({ id, label, description, Icon }) => {
              const checked = modules.includes(id);
              return (
                <label
                  key={id}
                  className={`flex cursor-pointer gap-3 rounded-xl border p-3 ${checked ? 'border-primary/40 bg-primary/5' : 'border-border'}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleModule(id)}
                    aria-label={label}
                    className="mt-1"
                  />
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <span>
                    <span className="block text-sm font-medium">{label}</span>
                    <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                      {description}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          {modules.includes('autonomous_red_team') && targets.isSuccess && !hasJudge && (
            <p className="mt-2 text-xs text-destructive">
              自主红队需要独立判定模型，请先到平台设置完成配置。
            </p>
          )}
        </Field>

        <Field
          label="样本数量"
          required
          hint="切换测试方式会载入推荐数量；你可以继续逐项修改。自主红队按场景计数，每个场景可能执行多轮攻击。"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {COUNT_MODULES.filter(({ id }) => modules.includes(id)).map(({ id, label }) => {
              const limits = countLimits(id, mode);
              return (
                <Field
                  key={id}
                  label={label}
                  htmlFor={`comprehensive-count-${id}`}
                  hint={`${limits.min}-${limits.max}`}
                >
                  <Input
                    id={`comprehensive-count-${id}`}
                    type="number"
                    min={limits.min}
                    max={limits.max}
                    step={1}
                    value={sampleCounts[id]}
                    onChange={(event) =>
                      setSampleCounts((current) => ({ ...current, [id]: event.target.value }))
                    }
                  />
                </Field>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            当前自动测试计划约 {plannedSampleCount} 条；回归样本和运行轨迹在选择后另行计入。
          </p>
        </Field>

        {modules.includes('sample_regression') && (
          <Field
            label="纳入回归的样本库"
            required
            hint={mode === 'full' ? '全量复制为任务快照。' : '每个样本库随机抽取最多 10 条。'}
          >
            <div className="max-h-40 space-y-1.5 overflow-y-auto rounded-xl border border-line p-3">
              {questionSets.isLoading ? (
                <Spinner className="h-4 w-4" />
              ) : (
                questionSets.data?.items
                  .filter((set) => set.enabled !== false)
                  .map((set) => (
                    <label key={set.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={regressionQuestionSetIds.includes(set.id)}
                        onChange={() => toggleRegressionSet(set.id)}
                      />
                      <span>{set.name}</span>
                      <span className="text-xs text-muted-foreground">
                        （{set.questionCount.toLocaleString('zh-CN')} 条）
                      </span>
                    </label>
                  ))
              )}
            </div>
          </Field>
        )}

        {modules.includes('runtime_trace') && (
          <Field
            label="ADR-compatible 运行轨迹"
            required
            hint="仅保存匿名指纹、计数和脱敏风险项，不保存完整会话。"
          >
            <Input
              type="file"
              accept="application/json,.json"
              aria-label="ADR 运行轨迹文件"
              onChange={(event) => void readAdrFile(event.target.files?.[0])}
            />
            {adrFilename && <p className="mt-1 text-xs text-emerald-700">已载入：{adrFilename}</p>}
          </Field>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="复测 seed"
            htmlFor="comprehensive-seed"
            hint="留空自动生成；填写后可复现抽样和混排顺序。"
          >
            <Input
              id="comprehensive-seed"
              value={seed}
              maxLength={128}
              placeholder="例如 release-2026-08"
              onChange={(event) => setSeed(event.target.value)}
            />
          </Field>
          <Field label="并发数" htmlFor="comprehensive-concurrency">
            <Select
              id="comprehensive-concurrency"
              value={concurrency}
              onChange={(event) => setConcurrency(event.target.value)}
            >
              {[1, 2, 4, 8].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>
    </Modal>
  );
}
