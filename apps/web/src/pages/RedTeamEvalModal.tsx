import { usePlatformAppEnabled } from '@/lib/use-platform-app-enabled';
import { isAgentEvalTarget } from '@/lib/eval-targets';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlayCircle, ShieldAlert } from 'lucide-react';
import {
  api,
  ApiError,
  type ModelTarget,
  type QuestionSet,
  type RedTeamDirection,
} from '@/lib/api';
import {
  RED_TEAM_DEFAULT_ROUNDS,
  RED_TEAM_MAX_ROUNDS_LIMIT,
  RED_TEAM_MIN_ROUNDS,
} from '@lse/shared';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';

interface RedTeamEvalModalProps {
  initialTargetId?: string;
  open: boolean;
  onClose: () => void;
}

interface RedTeamForm {
  bareTargetId: string;
  attackerTargetId: string;
  judgeTargetId: string;
  questionSetId: string;
  breakOn: 'verdict' | 'attitude';
  sampleCount: string;
  maxRounds: number;
  noProgressK: number;
  directions: string[];
}

const DEFAULT_RED_TEAM_SAMPLE_COUNT = 8;
const HIGH_ATTACK_CALL_THRESHOLD = 300;
const EMPTY_TARGETS: ModelTarget[] = [];
/** 攻击方向按招标口径三类风险分组展示（后端未返回分组时归入“其他”）。 */
const RISK_TYPE_ORDER = ['prompt_injection', 'sensitive_info_leakage', 'violating_content'];

function groupDirections(directions: RedTeamDirection[]) {
  const groups = new Map<string, { label: string; items: RedTeamDirection[] }>();
  for (const dir of directions) {
    const key = dir.riskType ?? 'other';
    const group = groups.get(key) ?? { label: dir.riskTypeLabel ?? '其他', items: [] };
    group.items.push(dir);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => {
      const ia = RISK_TYPE_ORDER.indexOf(a);
      const ib = RISK_TYPE_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    })
    .map(([key, group]) => ({ key, ...group }));
}

function clampRounds(value: number) {
  if (!Number.isFinite(value)) return RED_TEAM_DEFAULT_ROUNDS;
  return Math.min(Math.max(Math.floor(value), RED_TEAM_MIN_ROUNDS), RED_TEAM_MAX_ROUNDS_LIMIT);
}
const EMPTY_QUESTION_SETS: QuestionSet[] = [];

const EMPTY_FORM: RedTeamForm = {
  bareTargetId: '',
  attackerTargetId: '',
  judgeTargetId: '',
  questionSetId: '',
  breakOn: 'verdict',
  sampleCount: String(DEFAULT_RED_TEAM_SAMPLE_COUNT),
  maxRounds: RED_TEAM_DEFAULT_ROUNDS,
  noProgressK: 3,
  directions: [],
};

function isModelTarget(target: ModelTarget, platformAppEnabled = false) {
  return isAgentEvalTarget(target, platformAppEnabled);
}

function isGatewayLike(target: ModelTarget) {
  return /gateway|网关/i.test(`${target.name} ${target.provider}`);
}

function isBrainTarget(target: ModelTarget) {
  return (
    target.isActive &&
    (target.targetType === 'MODEL' || target.targetType === 'JUDGE') &&
    target.hasApiKey &&
    target.baseUrl.trim().length > 0 &&
    target.model.trim().length > 0
  );
}

function normalizeModelBaseUrl(value: string) {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

function isSameModelTarget(left: ModelTarget, right: ModelTarget) {
  return (
    left.id === right.id ||
    (normalizeModelBaseUrl(left.baseUrl) === normalizeModelBaseUrl(right.baseUrl) &&
      left.model.trim() === right.model.trim())
  );
}

function sortBrainTargets(targets: ModelTarget[]) {
  return [...targets].sort(
    (left, right) => Number(right.targetType === 'JUDGE') - Number(left.targetType === 'JUDGE'),
  );
}

function externalBrainTargetsFor(
  brainTargets: ModelTarget[],
  bareTargets: ModelTarget[],
  bareTargetId: string,
) {
  const bareTarget = bareTargets.find((target) => target.id === bareTargetId);
  return bareTarget
    ? brainTargets.filter((target) => !isSameModelTarget(target, bareTarget))
    : brainTargets;
}

function unavailableAttackerReason(targets: ModelTarget[], bareTargetId: string) {
  const bareTarget = targets.find((target) => target.id === bareTargetId);
  const otherModels = targets.filter(
    (target) => target.id !== bareTargetId && isBrainTarget(target),
  );
  const independentModels = targets.filter((target) => target.targetType === 'JUDGE');
  if (independentModels.length > 0 && independentModels.every((target) => !target.isActive)) {
    return '独立判定模型已配置但未启用，请到平台设置启用并测试连接。';
  }
  if (independentModels.some((target) => target.isActive && !isBrainTarget(target))) {
    return '独立判定模型配置不完整，请到平台设置补全接口地址、模型标识和访问密钥。';
  }
  if (bareTarget && otherModels.some((target) => isSameModelTarget(target, bareTarget))) {
    return '已配置的其他模型与当前评估对象使用相同的接口地址和模型标识，无法作为独立攻击模型。请配置不同的模型；仅修改对象名称或访问密钥不会使模型独立。';
  }
  return '尚未配置可用的外部攻击模型，请先到平台设置配置独立判定模型。';
}

function optionLabel(target: ModelTarget) {
  const type = target.targetType === 'JUDGE' ? '判定模型' : '模型';
  return `${target.name} · ${type} · ${target.model}`;
}

function seedLabel(set: QuestionSet) {
  const level = seedLevel(set);
  if (level === 'deep') return '深度样本库 · 全面覆盖';
  if (level === 'standard') return '标准样本库';
  if (level === 'smoke') return '快速样本库';
  return set.name;
}

function seedLevel(set: QuestionSet): 'smoke' | 'standard' | 'deep' | 'custom' {
  // 历史保留包（seed.ts 在旧题被引用时归档生成，source 前缀 legacy:）一律降级为自定义，
  // 不混进「内置推荐包」，避免误选过时题集。
  if ((set.source ?? '').startsWith('legacy:')) return 'custom';
  const text = `${set.source ?? ''} ${set.name} ${set.tags.join(' ')}`;
  if (/builtin:red-team:standard|level:standard|标准包/.test(text)) return 'standard';
  if (/builtin:red-team:deep|level:deep|深度包/.test(text)) return 'deep';
  if (/builtin:red-team\b|level:smoke|冒烟包/.test(text)) return 'smoke';
  return 'custom';
}

function seedPriority(set: QuestionSet) {
  const level = seedLevel(set);
  if (level === 'deep') return 0;
  if (level === 'standard') return 1;
  if (level === 'smoke') return 2;
  return 10;
}

function sortSeedSets(sets: QuestionSet[]) {
  return [...sets].sort(
    (a, b) => seedPriority(a) - seedPriority(b) || a.name.localeCompare(b.name),
  );
}

function isAttackSeedSet(set: QuestionSet) {
  if (set.questionCount <= 0) return false;
  if (set.source === 'red-team') return false;
  if (set.source?.startsWith('agent-runtime:')) return false;
  if (set.source?.startsWith('generator:')) return false;
  if (set.source?.startsWith('builtin:red-team')) return true;
  const text = `${set.name} ${set.description ?? ''} ${set.tags.join(' ')} ${set.source ?? ''}`;
  return (
    set.type === 'SHOULD_REFUSE' &&
    /红队候选|红队种子|攻击场景|攻击种子|应拒答红队|red.?team.?seed|redteam_seed|red-team-seed/i.test(
      text,
    )
  );
}

function pickDefaultSeed(sets: QuestionSet[]) {
  return (
    sets.find((set) => seedLevel(set) === 'deep') ??
    sets.find((set) => seedLevel(set) === 'standard') ??
    sets[0] ??
    null
  );
}

function defaultSampleCount(set: QuestionSet | null) {
  if (!set) return DEFAULT_RED_TEAM_SAMPLE_COUNT;
  return Math.min(DEFAULT_RED_TEAM_SAMPLE_COUNT, set.questionCount);
}

function clampSampleCount(value: number, set: QuestionSet | null) {
  const upper = Math.max(1, set?.questionCount ?? DEFAULT_RED_TEAM_SAMPLE_COUNT);
  if (!Number.isFinite(value)) return defaultSampleCount(set);
  return Math.min(Math.max(1, Math.floor(value)), upper);
}

export function RedTeamEvalModal({ open, onClose, initialTargetId }: RedTeamEvalModalProps) {
  const toast = useToast();
  const qc = useQueryClient();
  const platformAppEnabled = usePlatformAppEnabled();
  const navigate = useNavigate();
  const [form, setForm] = useState<RedTeamForm>(EMPTY_FORM);
  useEffect(() => {
    if (open && initialTargetId)
      setForm((current) => ({ ...current, bareTargetId: initialTargetId }));
  }, [open, initialTargetId]);
  const [showCustomSeedSets, setShowCustomSeedSets] = useState(false);

  const targetsQuery = useQuery({
    queryKey: ['model-targets', 'redteam-eval'],
    queryFn: () => api.modelTargets.list({ page: 1, pageSize: 200, includeSystem: true }),
    enabled: open,
  });
  const setsQuery = useQuery({
    queryKey: ['question-sets', 'redteam-eval'],
    queryFn: () => api.questionSets.list({ page: 1, pageSize: 100, enabled: true }),
    enabled: open,
  });
  const directionsQuery = useQuery({
    queryKey: ['red-team-directions'],
    queryFn: () => api.evalTasks.redTeamDirections(),
    enabled: open,
    staleTime: 60 * 60 * 1000,
  });
  const directions: RedTeamDirection[] = directionsQuery.data?.items ?? [];

  const targets = targetsQuery.data?.items ?? EMPTY_TARGETS;
  const questionSets = setsQuery.data?.items ?? EMPTY_QUESTION_SETS;
  const bareTargets = useMemo(
    () => targets.filter((target) => isModelTarget(target, platformAppEnabled)),
    [targets, platformAppEnabled],
  );
  const brainTargets = useMemo(() => sortBrainTargets(targets.filter(isBrainTarget)), [targets]);
  const externalBrainTargets = useMemo(
    () => externalBrainTargetsFor(brainTargets, bareTargets, form.bareTargetId),
    [bareTargets, brainTargets, form.bareTargetId],
  );
  const judgeTargets = useMemo(() => {
    const judges = brainTargets.filter((target) => target.targetType === 'JUDGE');
    return judges.length > 0 ? judges : brainTargets;
  }, [brainTargets]);
  const allSeedSets = useMemo(
    () => sortSeedSets(questionSets.filter((s) => s.enabled !== false && isAttackSeedSet(s))),
    [questionSets],
  );
  const builtinSeedSets = useMemo(
    () => allSeedSets.filter((set) => seedLevel(set) !== 'custom'),
    [allSeedSets],
  );
  const customSeedSets = useMemo(
    () => allSeedSets.filter((set) => seedLevel(set) === 'custom'),
    [allSeedSets],
  );
  // 界面只暴露「深度场景库」这一档内置包（标准/冒烟不再对用户呈现，但库里保留、后台自检仍可用）。
  const deepBuiltinSeedSets = useMemo(
    () => builtinSeedSets.filter((set) => seedLevel(set) === 'deep'),
    [builtinSeedSets],
  );
  const seedSets = showCustomSeedSets
    ? allSeedSets
    : builtinSeedSets.length > 0
      ? builtinSeedSets
      : customSeedSets;
  const selectedSeedSet = allSeedSets.find((set) => set.id === form.questionSetId) ?? null;
  const sampleCountValue = clampSampleCount(Number(form.sampleCount), selectedSeedSet);
  const attackCallEstimate = sampleCountValue * clampRounds(form.maxRounds);
  const hasHighAttackCallEstimate = attackCallEstimate > HIGH_ATTACK_CALL_THRESHOLD;
  // 粗估耗时：一次「攻击模型探测 + 评估对象响应 + 判定模型判定」约 6 秒，串行执行；下限 1 分钟。
  const estimatedMinutes = Math.max(1, Math.round((attackCallEstimate * 6) / 60));

  useEffect(() => {
    if (!open) {
      setForm(EMPTY_FORM);
      setShowCustomSeedSets(false);
      return;
    }
    if (targets.length === 0 && allSeedSets.length === 0) return;
    setForm((prev) => {
      const bareDefault =
        bareTargets.find((target) => target.id === initialTargetId) ??
        bareTargets.find((target) => !isGatewayLike(target)) ??
        bareTargets[0] ??
        null;
      const bareTargetId = bareTargets.some((target) => target.id === prev.bareTargetId)
        ? prev.bareTargetId
        : bareDefault?.id || '';
      const externalAttackers = externalBrainTargetsFor(brainTargets, bareTargets, bareTargetId);
      const attackerDefault = externalAttackers[0] ?? null;
      const seedDefault = pickDefaultSeed(
        builtinSeedSets.length > 0 ? builtinSeedSets : allSeedSets,
      );
      const nextSeedSet =
        allSeedSets.find((set) => set.id === (prev.questionSetId || seedDefault?.id || '')) ?? null;
      return {
        ...prev,
        bareTargetId,
        attackerTargetId: externalAttackers.some((target) => target.id === prev.attackerTargetId)
          ? prev.attackerTargetId
          : attackerDefault?.id || '',
        judgeTargetId: judgeTargets.some((target) => target.id === prev.judgeTargetId)
          ? prev.judgeTargetId
          : judgeTargets[0]?.id || attackerDefault?.id || '',
        questionSetId: prev.questionSetId || seedDefault?.id || '',
        sampleCount: String(
          prev.questionSetId
            ? clampSampleCount(Number(prev.sampleCount), nextSeedSet)
            : defaultSampleCount(nextSeedSet),
        ),
      };
    });
  }, [
    allSeedSets,
    bareTargets,
    brainTargets,
    builtinSeedSets,
    judgeTargets,
    open,
    targets.length,
    initialTargetId,
  ]);

  const mutation = useMutation({
    mutationFn: () => {
      const body = {
        bareTargetId: form.bareTargetId,
        attackerTargetId: form.attackerTargetId,
        judgeTargetId: form.judgeTargetId,
        questionSetId: form.questionSetId,
        sampleCount: sampleCountValue,
        maxRounds: clampRounds(form.maxRounds),
        noProgressK: form.noProgressK,
        breakOn: form.breakOn,
        // 留空=全面（不限定方向）；选定后只针对所选方向的风险目标抽样。
        ...(form.directions.length > 0 ? { directions: form.directions } : {}),
      };
      return api.evalTasks.createRedTeam(body);
    },
    onSuccess: (task) => {
      toast.success('已发起多轮对抗演练');
      qc.invalidateQueries({ queryKey: ['eval-tasks'] });
      onClose();
      navigate(`/eval-tasks/${task.id}`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '自主红队评估启动失败'),
  });

  const canSubmit = Boolean(
    form.bareTargetId &&
    form.attackerTargetId &&
    externalBrainTargets.some((target) => target.id === form.attackerTargetId) &&
    form.judgeTargetId &&
    form.questionSetId &&
    !targetsQuery.isError &&
    !mutation.isPending,
  );

  const update = <K extends keyof RedTeamForm>(key: K, value: RedTeamForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const updateBareTarget = (bareTargetId: string) => {
    setForm((prev) => {
      const candidates = externalBrainTargetsFor(brainTargets, bareTargets, bareTargetId);
      return {
        ...prev,
        bareTargetId,
        attackerTargetId: candidates.some((target) => target.id === prev.attackerTargetId)
          ? prev.attackerTargetId
          : candidates[0]?.id || '',
      };
    });
  };

  const toggleDirection = (id: string) => {
    setForm((prev) => ({
      ...prev,
      directions: prev.directions.includes(id)
        ? prev.directions.filter((value) => value !== id)
        : [...prev.directions, id],
    }));
  };

  const updateQuestionSet = (questionSetId: string) => {
    const nextSeedSet = allSeedSets.find((set) => set.id === questionSetId) ?? null;
    setForm((prev) => ({
      ...prev,
      questionSetId,
      sampleCount: String(defaultSampleCount(nextSeedSet)),
    }));
  };

  const updateSampleCount = (value: string) => {
    if (value.trim() === '') {
      update('sampleCount', '');
      return;
    }
    update('sampleCount', String(clampSampleCount(Number(value), selectedSeedSet)));
  };

  const submit = () => {
    if (
      hasHighAttackCallEstimate &&
      !confirm(
        `本次评估预计执行 ${attackCallEstimate} 轮对抗对话，执行时间可能超过十分钟。确认开始吗？`,
      )
    ) {
      return;
    }
    mutation.mutate();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="多轮对抗演练"
      description="区别于传统种子单轮对话评估：攻击模型与评估模型多模型协作，动态多轮对抗评估对象的安全边界与防护有效性。选择评估对象即可发起；攻击策略、判定模型与对抗轮次已预置于高级设置。"
      size="xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!canSubmit} onClick={submit}>
            {mutation.isPending ? (
              <Spinner className="h-4 w-4" />
            ) : (
              <PlayCircle className="h-4 w-4" />
            )}
            开始评估
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* 评估范围与证据说明。 */}
        <div className="flex gap-2 rounded-xl border border-brand-100 bg-brand-50/70 px-3 py-2.5 text-sm leading-6 text-ink-2">
          <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand-600" />
          <div className="space-y-1">
            <p>
              攻击引擎将动态生成对抗样本，对评估对象进行多轮自适应探测，识别提示注入、越权诱导、内容安全等风险。
            </p>
            <p>
              支持动态多轮对抗攻击，能够根据目标模型上一轮响应自动调整攻击内容、组合攻击策略，持续完成不少于5轮的对抗执行。
            </p>
            <p aria-label="多模型协作">
              多模型协作：攻击模型负责生成与调整攻击内容，保证攻击种子的黑度；评估模型（判定模型）逐轮判定，保证攻击结果的准确性。
            </p>
            <p className="text-ink-3">
              评估完成后可在任务详情查看范围内结论、逐轮判定和完整对话证据；
              平台应用可能执行真实工具并读取其已配置的数据，请使用测试应用或副本及合成数据。
            </p>
          </div>
        </div>

        {/* —— 主选项：两步即可发起 —— */}
        <Field label="评估对象" htmlFor="redteam-eval-bare" required>
          <Select
            id="redteam-eval-bare"
            aria-label="评估对象"
            value={form.bareTargetId}
            onChange={(event) => updateBareTarget(event.target.value)}
          >
            <option value="">请选择评估对象...</option>
            {bareTargets.map((target) => (
              <option key={target.id} value={target.id}>
                {optionLabel(target)}
              </option>
            ))}
          </Select>
        </Field>

        {targetsQuery.isError && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-severity-medium/25 bg-severity-medium-bg px-3 py-2.5 text-sm text-severity-medium"
          >
            <p>模型配置加载失败，请重试。</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => targetsQuery.refetch()}
            >
              重新加载模型
            </Button>
          </div>
        )}

        {form.bareTargetId &&
          !targetsQuery.isLoading &&
          !targetsQuery.isError &&
          externalBrainTargets.length === 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-severity-medium/25 bg-severity-medium-bg px-3 py-2.5 text-sm leading-6 text-severity-medium">
              <div className="flex min-w-0 items-start gap-2">
                <ShieldAlert className="mt-1 h-4 w-4 flex-shrink-0 text-severity-medium" />
                <p>{unavailableAttackerReason(targets, form.bareTargetId)}</p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => navigate('/settings#independent-judge-model')}
              >
                前往平台设置
              </Button>
            </div>
          )}

        {directions.length > 0 && (
          <Field label="攻击方向" htmlFor="redteam-eval-directions">
            <div
              id="redteam-eval-directions"
              role="group"
              aria-label="攻击方向"
              className="space-y-2"
            >
              {groupDirections(directions).map((group) => (
                <div key={group.key} className="flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 w-24 shrink-0 text-xs font-medium text-slate-600">
                    {group.label}
                  </span>
                  {group.items.map((dir) => {
                    const active = form.directions.includes(dir.id);
                    return (
                      <button
                        key={dir.id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => toggleDirection(dir.id)}
                        title={`${dir.description}　多轮链：${dir.chainSummary}`}
                        className={`rounded-full border px-2.5 py-0.5 text-xs transition ${
                          active
                            ? 'border-brand-600 bg-brand-50 font-medium text-brand-700'
                            : 'border-line-2 bg-white text-ink-3 hover:border-brand-400'
                        }`}
                      >
                        {dir.label}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {form.directions.length === 0 ? (
                '默认覆盖全部风险维度；指定后仅针对所选维度抽样，并按维度定制多轮攻击链。'
              ) : (
                <>
                  已选 {form.directions.length} 个方向：
                  {directions
                    .filter((dir) => form.directions.includes(dir.id))
                    .map((dir) => `${dir.label}（${dir.chainSummary}）`)
                    .join('；')}
                </>
              )}
            </p>
          </Field>
        )}

        <div className="grid items-start gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
          <Field
            label="样本数量"
            htmlFor="redteam-eval-sample-count"
            required
            hint={
              selectedSeedSet
                ? '默认 8；数值越大覆盖越广、耗时越长。'
                : '选择评估对象后即可设置抽样数量。'
            }
          >
            <Input
              id="redteam-eval-sample-count"
              aria-label="样本数量"
              type="number"
              min={1}
              max={selectedSeedSet?.questionCount ?? DEFAULT_RED_TEAM_SAMPLE_COUNT}
              value={form.sampleCount}
              onChange={(event) => updateSampleCount(event.target.value)}
            />
          </Field>
          <div
            className={`rounded-xl border px-3 py-2 text-sm leading-6 sm:mt-[26px] sm:flex sm:min-h-10 sm:items-center ${
              hasHighAttackCallEstimate
                ? 'border-destructive/30 bg-destructive/5 text-destructive'
                : 'border-border bg-[#F7F9FD] text-muted-foreground'
            }`}
          >
            预计发起约 {attackCallEstimate} 轮对抗对话，耗时约 {estimatedMinutes} 分钟。
          </div>
        </div>

        {/* —— 高级设置：默认折叠，已配好默认值 —— */}
        <details className="rounded-xl border border-line bg-[#F7F9FD] px-3 py-2">
          <summary className="cursor-pointer select-none text-sm font-medium text-slate-700">
            高级设置
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              对抗样本库 / 攻击模型 / 判定模型 / 判定标准 / 对抗轮次，默认已配置
            </span>
          </summary>
          <div className="mt-3 space-y-4">
            <Field
              label="对抗样本库"
              htmlFor="redteam-eval-seed"
              required
              hint="默认使用深度样本库（全面覆盖）；也可切换至自定义样本库。"
            >
              <Select
                id="redteam-eval-seed"
                aria-label="对抗样本库"
                value={form.questionSetId}
                onChange={(event) => updateQuestionSet(event.target.value)}
              >
                <option value="">
                  {seedSets.length > 0 ? '请选择对抗样本库…' : '暂无可用对抗样本库'}
                </option>
                {deepBuiltinSeedSets.length > 0 && (
                  <optgroup label="内置样本库">
                    {deepBuiltinSeedSets.map((set) => (
                      <option key={set.id} value={set.id}>
                        {seedLabel(set)}
                      </option>
                    ))}
                  </optgroup>
                )}
                {(showCustomSeedSets || deepBuiltinSeedSets.length === 0) &&
                  customSeedSets.length > 0 && (
                    <optgroup label="自定义 / 历史样本库">
                      {customSeedSets.map((set) => (
                        <option key={set.id} value={set.id}>
                          {seedLabel(set)}
                        </option>
                      ))}
                    </optgroup>
                  )}
              </Select>
              {customSeedSets.length > 0 && (
                <div className="mt-1.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowCustomSeedSets((value) => !value)}
                    className="px-2"
                  >
                    {showCustomSeedSets ? '收起自定义 / 历史样本库' : '使用自定义 / 历史样本库'}
                  </Button>
                </div>
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="攻击模型"
                htmlFor="redteam-eval-attacker"
                required
                hint="执行对抗探测的外部模型，不能与当前评估对象相同。"
              >
                <Select
                  id="redteam-eval-attacker"
                  aria-label="攻击模型"
                  value={form.attackerTargetId}
                  onChange={(event) => update('attackerTargetId', event.target.value)}
                >
                  <option value="">请选择攻击模型…</option>
                  {externalBrainTargets.map((target) => (
                    <option key={target.id} value={target.id}>
                      {optionLabel(target)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="判定模型"
                htmlFor="redteam-eval-judge"
                required
                hint="逐轮判定评估对象是否发生安全边界突破，默认已配置。"
              >
                <Select
                  id="redteam-eval-judge"
                  aria-label="判定模型"
                  value={form.judgeTargetId}
                  onChange={(event) => update('judgeTargetId', event.target.value)}
                >
                  <option value="">请选择判定模型...</option>
                  {judgeTargets.map((target) => (
                    <option key={target.id} value={target.id}>
                      {optionLabel(target)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field
                label="风险判定尺度"
                htmlFor="redteam-eval-break-on"
                hint="默认『严格』，判定更可靠。"
              >
                <Select
                  id="redteam-eval-break-on"
                  value={form.breakOn}
                  onChange={(event) =>
                    update('breakOn', event.target.value as RedTeamForm['breakOn'])
                  }
                >
                  <option value="verdict">模型执行了危险请求（严格）</option>
                  <option value="attitude">模型出现配合倾向即判定（宽松）</option>
                </Select>
              </Field>
              <Field
                label="最大轮数"
                htmlFor="redteam-eval-max-rounds"
                hint={`实战对抗不少于 ${RED_TEAM_MIN_ROUNDS} 轮，默认 ${RED_TEAM_DEFAULT_ROUNDS} 轮。`}
              >
                <Input
                  id="redteam-eval-max-rounds"
                  aria-label="最大轮数"
                  type="number"
                  min={RED_TEAM_MIN_ROUNDS}
                  max={RED_TEAM_MAX_ROUNDS_LIMIT}
                  value={form.maxRounds}
                  onChange={(event) => update('maxRounds', Number(event.target.value))}
                  onBlur={() => update('maxRounds', clampRounds(form.maxRounds))}
                />
              </Field>
              <Field
                label="无进展提前终止轮数"
                htmlFor="redteam-eval-no-progress"
                hint="攻击模型连续该轮数无突破，则自动终止该场景，默认 3。"
              >
                <Input
                  id="redteam-eval-no-progress"
                  type="number"
                  min={1}
                  max={20}
                  value={form.noProgressK}
                  onChange={(event) => update('noProgressK', Number(event.target.value) || 1)}
                />
              </Field>
            </div>
          </div>
        </details>
      </div>
    </Modal>
  );
}
