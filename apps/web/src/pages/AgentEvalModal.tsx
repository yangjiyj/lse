import { usePlatformAppEnabled } from '@/lib/use-platform-app-enabled';
import { isAgentEvalTarget } from '@/lib/eval-targets';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Info, PlayCircle, SlidersHorizontal } from 'lucide-react';
import {
  api,
  ApiError,
  type AgentEvalLevel,
  type AgentEvalRunBody,
  type AgentRiskSurface,
  type ModelTarget,
} from '@/lib/api';
import { agentPackLabel, agentRiskSurfaceLabel, formatDateTime } from '@/lib/format';
import {
  AGENTIC_DIMENSIONS,
  AGENTIC_DIMENSION_LABELS,
  AGENT_RISK_SURFACE_DIMENSION,
  type AgenticDimension,
} from '@lse/shared';
import { useDemoMode } from '@/lib/use-demo-mode';
import { AgentStrengthControl, agentStrengthOption } from '@/components/AgentStrengthControl';
import { AgentTechniquePicker } from '@/components/AgentTechniquePicker';
import { AdaptiveAttackConfig } from '@/components/AdaptiveAttackConfig';
import { Modal } from '@/components/ui/modal';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { randomId } from '@/lib/random-id';

const ALL_RISK_SURFACES: AgentRiskSurface[] = [
  'ssrf',
  'secret_read',
  'file_read',
  'dangerous_command',
  'data_exfiltration',
  'indirect_prompt_injection',
  'tool_argument_bypass',
];
const DEFAULT_PACK_IDS = ['builtin-agent-attacks'];
const PLATFORM_PACK_V1 = 'platform-app-v1';
const PLATFORM_PACK_V2 = 'platform-app-v2';
type PlatformPackId = typeof PLATFORM_PACK_V1 | typeof PLATFORM_PACK_V2;

// 平台应用对象的场景包二选一，默认 v1。说明文案面向用户，只用“暗号”“蜜罐文档”等已有写法。
const PLATFORM_PACK_OPTIONS: { id: PlatformPackId; label: string; description: string }[] = [
  {
    id: PLATFORM_PACK_V1,
    label: '标准场景（v1）',
    description:
      '覆盖系统提示词泄露、知识库越权、网页间接注入、工具外发和回答外带五类场景，每类一种提问方式，耗时较短。',
  },
  {
    id: PLATFORM_PACK_V2,
    label: '扩展场景（v2：多轮、更多变体）',
    description:
      '在标准场景的基础上增加多轮对话场景（先铺垫、再提出越权要求），每类含更多提问变体（如角色扮演、翻译、分步套取、多种网页注入形式）。对话轮数更多，预计执行时间更长。',
  },
];

// 为每个风险面补充面向用户的行为说明。
const RISK_SURFACE_BLURB: Record<AgentRiskSurface, string> = {
  ssrf: '验证非授权内网、回环或云元数据访问',
  secret_read: '验证密码、密钥和访问凭据读取',
  file_read: '验证非授权服务器文件访问',
  dangerous_command: '验证删除、格式化等高危命令执行',
  data_exfiltration: '验证业务数据非授权外发',
  indirect_prompt_injection: '验证网页或文档中的间接提示注入',
  tool_argument_bypass: '验证工具参数约束绕过和非授权调用',
};

interface AgentEvalModalProps {
  initialTargetId?: string;
  open: boolean;
  onClose: () => void;
}

function defaultRiskSurfaces(level: AgentEvalLevel): AgentRiskSurface[] {
  return [...agentStrengthOption(level).riskSurfaces];
}

function executableTarget(target: ModelTarget, platformAppEnabled = false): boolean {
  return isAgentEvalTarget(target, platformAppEnabled);
}

function targetOptionLabel(target: ModelTarget): string {
  if (target.targetType === 'AGENT_API') return `${target.name}（评估对象）`;
  return `${target.name}（${target.model}）`;
}

export function AgentEvalModal({ open, onClose, initialTargetId }: AgentEvalModalProps) {
  const platformAppEnabled = usePlatformAppEnabled();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { mode } = useDemoMode();
  const [modelTargetId, setModelTargetId] = useState('');
  useEffect(() => {
    if (open && initialTargetId) setModelTargetId(initialTargetId);
  }, [open, initialTargetId]);
  const [level, setLevel] = useState<AgentEvalLevel>('standard');
  const [advanced, setAdvanced] = useState(false);
  const [sampleCount, setSampleCount] = useState(
    String(agentStrengthOption('standard').defaultSampleCount),
  );
  const [seed, setSeed] = useState('');
  const [automaticSeed, setAutomaticSeed] = useState(() => randomId());
  const [riskSurfaces, setRiskSurfaces] = useState<AgentRiskSurface[]>(
    defaultRiskSurfaces('standard'),
  );
  const [packIds, setPackIds] = useState<string[]>(DEFAULT_PACK_IDS);
  const [platformPackId, setPlatformPackId] = useState<PlatformPackId>(PLATFORM_PACK_V1);
  const [maxConcurrency, setMaxConcurrency] = useState('4');
  const [timeoutMs, setTimeoutMs] = useState('');
  const [saveQuestionSet, setSaveQuestionSet] = useState(false);
  const [techniques, setTechniques] = useState<string[]>([]);
  // 参数9：默认追加目标劫持 / 伪造记忆 / 失败连锁调用 / 越权调用四类沙箱场景，覆盖五维度。
  const [agenticScenarios, setAgenticScenarios] = useState(true);
  // 高风险操作人工介入（13 个场景）：默认不追加，勾选后考察智能体执行高风险操作前是否请求确认。
  const [hitlScenarios, setHitlScenarios] = useState(true);
  const [adaptiveOverride, setAdaptiveOverride] = useState<{
    enabled: boolean;
    rounds?: number;
    attackerTargetId?: string;
  }>({ enabled: false });

  const selectedStrength = agentStrengthOption(level);
  const models = useQuery({
    queryKey: ['model-targets', 'active-for-agent-eval'],
    queryFn: () => api.modelTargets.list({ page: 1, pageSize: 100 }),
    enabled: open,
  });
  const isPlatform =
    models.data?.items.find((target) => target.id === modelTargetId)?.targetType === 'PLATFORM_APP';
  const effectivePackIds = useMemo(
    () => (isPlatform ? [platformPackId] : packIds),
    [isPlatform, platformPackId, packIds],
  );
  const effectiveSeed = seed.trim() || automaticSeed;
  const packs = useQuery({
    queryKey: ['agent-evals', 'packs'],
    queryFn: () => api.agentEvals.packs(),
    enabled: open && advanced,
  });
  const agentEvalConfig = useQuery({
    queryKey: ['agent-evals', 'config'],
    queryFn: () => api.agentEvals.getConfig(),
    enabled: open && advanced && mode === 'expert',
  });

  const sampleCountValue = useMemo(() => {
    const parsed = Math.floor(Number(sampleCount));
    if (!Number.isFinite(parsed)) return selectedStrength.defaultSampleCount;
    return Math.max(1, parsed);
  }, [sampleCount, selectedStrength.defaultSampleCount]);

  const maxConcurrencyValue = useMemo(() => {
    const parsed = Math.floor(Number(maxConcurrency));
    if (!Number.isFinite(parsed)) return 4;
    return Math.max(1, Math.min(32, parsed));
  }, [maxConcurrency]);

  const timeoutMsValue = useMemo(() => {
    const trimmed = timeoutMs.trim();
    if (!trimmed) return undefined;
    const parsed = Math.floor(Number(trimmed));
    if (!Number.isFinite(parsed)) return undefined;
    return Math.max(1000, Math.min(600000, parsed));
  }, [timeoutMs]);

  // 粗略耗时估算（纯前端展示，不参与任何请求/逻辑）：题数 × 每题约 15 秒 ÷ 同时测的道数。
  const estimatedMinutes = useMemo(() => {
    const perSampleSeconds = 15 * Math.max(1, selectedStrength.maxTurns);
    const seconds = (sampleCountValue * perSampleSeconds) / maxConcurrencyValue;
    return Math.max(1, Math.round(seconds / 60));
  }, [sampleCountValue, maxConcurrencyValue, selectedStrength.maxTurns]);

  const previewBody = useMemo(
    () => ({
      level,
      sampleCount: sampleCountValue,
      seed: effectiveSeed,
      riskSurfaces: isPlatform ? undefined : riskSurfaces,
      packIds: effectivePackIds,
      maxConcurrency: maxConcurrencyValue,
      timeoutMs: timeoutMsValue,
    }),
    [
      level,
      maxConcurrencyValue,
      effectivePackIds,
      riskSurfaces,
      sampleCountValue,
      effectiveSeed,
      timeoutMsValue,
      isPlatform,
    ],
  );
  const preview = useQuery({
    queryKey: ['agent-evals', 'preview', previewBody],
    queryFn: () => api.agentEvals.preview(previewBody),
    enabled: open && (advanced || isPlatform) && (isPlatform || riskSurfaces.length > 0),
    staleTime: 5000,
  });

  const reset = () => {
    setModelTargetId('');
    setLevel('standard');
    setAdvanced(false);
    setSampleCount(String(agentStrengthOption('standard').defaultSampleCount));
    setSeed('');
    setAutomaticSeed(randomId());
    setRiskSurfaces(defaultRiskSurfaces('standard'));
    setPackIds(DEFAULT_PACK_IDS);
    setPlatformPackId(PLATFORM_PACK_V1);
    setMaxConcurrency('4');
    setTimeoutMs('');
    setSaveQuestionSet(false);
    setTechniques([]);
    setAdaptiveOverride({ enabled: false });
  };

  useEffect(() => {
    if (!open) reset();
  }, [open]);

  const runMutation = useMutation({
    mutationFn: () => {
      const body: AgentEvalRunBody = {
        modelTargetId,
        level,
        agenticScenarios: isPlatform ? false : agenticScenarios,
        ...(!isPlatform && hitlScenarios ? { hitlScenarios: true } : {}),
      };
      if (isPlatform) {
        body.packIds = effectivePackIds;
        body.seed = effectiveSeed;
        body.sampleCount = sampleCountValue;
      }
      if (advanced) {
        body.sampleCount = sampleCountValue;
        if (!isPlatform) body.riskSurfaces = riskSurfaces;
        body.packIds = effectivePackIds;
        body.maxConcurrency = maxConcurrencyValue;
        body.saveQuestionSet = saveQuestionSet;
        body.seed = effectiveSeed;
        if (timeoutMsValue !== undefined) body.timeoutMs = timeoutMsValue;
        if (!isPlatform && techniques.length > 0) body.techniques = techniques;
        if (!isPlatform && adaptiveOverride.enabled) body.adaptiveOverride = adaptiveOverride;
      }
      return api.agentEvals.run(body);
    },
    onSuccess: (result) => {
      toast.success(`智能体安全评估已开始，共 ${result.sampleCount} 条测试样本。`);
      qc.invalidateQueries({ queryKey: ['eval-tasks'] });
      onClose();
      navigate(`/eval-tasks/${result.taskId}`);
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : '智能体安全评估启动失败，请稍后重试'),
  });

  const changeLevel = (next: AgentEvalLevel) => {
    const option = agentStrengthOption(next);
    setLevel(next);
    setSampleCount(String(option.defaultSampleCount));
    setRiskSurfaces([...option.riskSurfaces]);
  };

  const toggleRiskSurface = (surface: AgentRiskSurface) => {
    setRiskSurfaces((prev) => {
      const set = new Set(prev);
      if (set.has(surface)) set.delete(surface);
      else set.add(surface);
      return [...set];
    });
  };

  const togglePackId = (packId: string) => {
    setPackIds((prev) => {
      const set = new Set(prev);
      if (set.has(packId)) set.delete(packId);
      else set.add(packId);
      return [...set];
    });
  };

  const pack = packs.data?.items.find((item) => effectivePackIds.includes(item.id));
  const prerequisites = isPlatform
    ? (preview.data?.samples.flatMap((sample) =>
        Array.isArray(sample.metadata.prerequisites)
          ? sample.metadata.prerequisites.filter((item): item is string => typeof item === 'string')
          : [],
      ) ?? [])
    : [];
  const canSubmit =
    Boolean(modelTargetId) &&
    (isPlatform || riskSurfaces.length > 0) &&
    effectivePackIds.length > 0 &&
    (!isPlatform || preview.isSuccess) &&
    !runMutation.isPending;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="发起智能体工具安全评估"
      description="选择评估对象和评估强度。平台将生成场景样本，验证工具权限边界并记录证据链。"
      size="xl"
      footer={
        <Button disabled={!canSubmit} onClick={() => runMutation.mutate()}>
          {runMutation.isPending ? (
            <Spinner className="h-4 w-4" />
          ) : (
            <PlayCircle className="h-4 w-4" />
          )}
          开始评估
        </Button>
      }
    >
      <div className="space-y-5">
        <div className="flex gap-2 rounded-xl border border-brand-100 bg-brand-50/70 px-4 py-3 text-[13px] leading-6 text-ink-2">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            本次评估将通过预设场景验证评估对象是否触发敏感数据访问、内网访问或高危命令执行。
            <br />按{AGENTIC_DIMENSIONS.map((d) => AGENTIC_DIMENSION_LABELS[d]).join('、')}
            等维度评估。
            <br />
            模型场景使用隔离模拟工具；平台应用的工具由目标平台真实执行，评估仅事后观测。请使用测试应用或副本，仅配置受控接收端并使用合成数据。
          </div>
        </div>

        {!isPlatform && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              aria-label="追加四类沙箱场景"
              checked={agenticScenarios}
              onChange={(e) => setAgenticScenarios(e.target.checked)}
            />
            <span>
              <span className="font-medium">追加四类沙箱场景</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                工具返回内容改写目标、伪造记忆、工具失败连锁调用、越权调用高权限工具，均由沙箱确定性判定。
              </span>
            </span>
          </label>
        )}

        {!isPlatform && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              aria-label="追加高风险操作确认场景"
              checked={hitlScenarios}
              onChange={(e) => setHitlScenarios(e.target.checked)}
            />
            <span>
              <span className="font-medium">追加高风险操作确认场景</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                停服务、终止进程、格式化磁盘、批量删除、改权限、改密钥、开放端口、改防火墙、改系统设置、访问密码管理器、转账支付等 13 类操作，考察智能体执行前是否请求确认；直接执行判不符合。日志留存、紧急关停等黑盒测不了的要求，在报告中标「需人工填报」。
              </span>
            </span>
          </label>
        )}

        <Field label="评估对象" htmlFor="agent-eval-model" required>
          <Select
            id="agent-eval-model"
            aria-label="评估对象"
            value={modelTargetId}
            onChange={(e) => setModelTargetId(e.target.value)}
          >
            <option value="">请选择评估对象…</option>
            {models.data?.items
              .filter((target) => executableTarget(target, platformAppEnabled))
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {targetOptionLabel(m)}
                </option>
              ))}
          </Select>
        </Field>

        {isPlatform && (
          <Field label="平台场景包">
            <div role="radiogroup" aria-label="平台场景包" className="grid gap-2 sm:grid-cols-2">
              {PLATFORM_PACK_OPTIONS.map((option) => (
                <label
                  key={option.id}
                  className={`flex cursor-pointer items-start gap-2 rounded-xl border px-3 py-2 text-sm ${
                    platformPackId === option.id
                      ? 'border-brand-600'
                      : 'border-line hover:border-line-2'
                  }`}
                >
                  <input
                    type="radio"
                    name="agent-eval-platform-pack"
                    className="mt-1"
                    checked={platformPackId === option.id}
                    onChange={() => setPlatformPackId(option.id)}
                  />
                  <span>
                    <span className="font-medium">{option.label}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </Field>
        )}

        {isPlatform && (
          <div className="rounded-xl border border-line bg-[#F7F9FD] p-3 text-xs leading-6">
            <p className="font-semibold">
              平台智能体场景包：系统编排、知识库越权、网页间接注入、工具外发和回答外带
            </p>
            <p>
              知识库准备：请先按下列说明配置测试蜜罐文档，再开始评估。未配置时无法证明知识库权限安全。
            </p>
            {prerequisites.map((item, index) => (
              <p key={index}>{item}</p>
            ))}
            {preview.isFetching && <p>正在生成准备说明…</p>}
            {preview.isError && <p>场景预览失败，请检查连接后重试。</p>}
          </div>
        )}

        <div className="rounded-xl border border-line bg-[#F7F9FD] p-3 text-xs leading-6 text-muted-foreground">
          <p className="mb-1 text-sm font-semibold text-foreground">评估说明</p>
          {isPlatform
            ? '平台将发送场景样本，记录实际工具调用与事后观测证据。'
            : '平台将发送智能体场景样本，记录工具调用、策略判定和阻断证据。'}
          预计执行时间约为 <b className="text-foreground">{estimatedMinutes}</b> 分钟。
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-[#F7F9FD] px-3 py-2">
          <div className="text-xs text-muted-foreground">
            评估强度、样本数量、风险范围和场景样本包可在高级配置中调整
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => setAdvanced((v) => !v)}>
            <SlidersHorizontal className="h-3.5 w-3.5" />
            高级配置
            {advanced ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>

        {advanced && (
          <div className="space-y-4 rounded-xl border border-line p-4">
            {!isPlatform && (
              <Field label="评估强度" required>
                <AgentStrengthControl
                  value={level}
                  onChange={changeLevel}
                  disabled={runMutation.isPending}
                />
              </Field>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="样本数量"
                htmlFor="agent-eval-sample-count"
                hint={`建议范围跟随“${selectedStrength.label}”强度`}
              >
                <Input
                  id="agent-eval-sample-count"
                  aria-label="样本数量"
                  type="number"
                  min={isPlatform ? 5 : 1}
                  value={sampleCount}
                  onChange={(e) => setSampleCount(e.target.value)}
                />
              </Field>
              <Field
                label="复现种子（选填）"
                htmlFor="agent-eval-seed"
                hint="使用相同种子可生成一致的样本，便于前后结果对比。"
              >
                <Input
                  id="agent-eval-seed"
                  aria-label="复现编号"
                  value={seed}
                  onChange={(e) => setSeed(e.target.value)}
                  placeholder={effectiveSeed}
                />
              </Field>
              <Field
                label="并发数"
                htmlFor="agent-eval-max-concurrency"
                hint="并发数越高，资源占用越大。建议保留默认值 4。"
              >
                <Input
                  id="agent-eval-max-concurrency"
                  aria-label="同时评估的样本数量"
                  type="number"
                  min={1}
                  max={32}
                  value={maxConcurrency}
                  onChange={(e) => setMaxConcurrency(e.target.value)}
                />
              </Field>
              <Field
                label="单样本超时（毫秒）"
                htmlFor="agent-eval-timeout-ms"
                hint="超过该时限仍未返回响应时，样本将记为执行超时。"
              >
                <Input
                  id="agent-eval-timeout-ms"
                  aria-label="timeoutMs"
                  type="number"
                  min={1000}
                  max={600000}
                  value={timeoutMs}
                  onChange={(e) => setTimeoutMs(e.target.value)}
                  placeholder="留空即可，默认自动（如 60000，约 1 分钟）"
                />
              </Field>
            </div>

            {!isPlatform && (
              <Field
                label="场景样本包"
                error={packIds.length === 0 ? '请至少选择一个场景样本包' : undefined}
              >
                <div className="grid gap-2 sm:grid-cols-2">
                  {(packs.data?.items ?? [])
                    .filter((item) => item.id !== PLATFORM_PACK_V1)
                    .map((item) => (
                      <label
                        key={item.id}
                        className="flex items-start gap-2 rounded-xl border border-line px-3 py-2 text-sm"
                      >
                        <input
                          type="checkbox"
                          checked={packIds.includes(item.id)}
                          onChange={() => togglePackId(item.id)}
                        />
                        <span>
                          <span className="font-medium">{agentPackLabel(item.id)}</span>
                          <span className="ml-2 text-xs text-muted-foreground">{item.version}</span>
                        </span>
                      </label>
                    ))}
                  {packs.isLoading && (
                    <div className="text-xs text-muted-foreground">正在加载场景样本包…</div>
                  )}
                </div>
              </Field>
            )}

            {!isPlatform && (
              <Field
                label="风险范围"
                error={riskSurfaces.length === 0 ? '请至少选择一个风险范围' : undefined}
              >
                <div className="grid gap-2 sm:grid-cols-2">
                  {ALL_RISK_SURFACES.map((surface) => (
                    <label
                      key={surface}
                      className="flex items-start gap-2 rounded-xl border border-line px-3 py-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={riskSurfaces.includes(surface)}
                        onChange={() => toggleRiskSurface(surface)}
                      />
                      <span>
                        <span className="font-medium">{agentRiskSurfaceLabel(surface)}</span>
                        <span className="ml-1 text-xs text-ink-3">
                          {
                            AGENTIC_DIMENSION_LABELS[
                              AGENT_RISK_SURFACE_DIMENSION[surface] as AgenticDimension
                            ]
                          }
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {RISK_SURFACE_BLURB[surface]}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </Field>
            )}

            {!isPlatform &&
              (mode === 'expert' ? (
                <>
                  <Field label="攻击技术" hint="未选择时使用全部内置攻击技术。">
                    <AgentTechniquePicker
                      techniques={agentEvalConfig.data?.techniques ?? []}
                      selected={techniques}
                      onChange={setTechniques}
                    />
                  </Field>
                  <Field
                    label="自适应攻击"
                    hint="根据评估对象的响应动态调整后续攻击策略。启用后执行时间可能增加。"
                  >
                    <AdaptiveAttackConfig
                      value={adaptiveOverride}
                      onChange={setAdaptiveOverride}
                      attackerTargets={(models.data?.items ?? []).filter(
                        (target) => target.isActive && target.targetType === 'MODEL',
                      )}
                    />
                  </Field>
                </>
              ) : (
                <div className="space-y-2 rounded-xl border border-line bg-[#F7F9FD] px-3 py-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">攻击技术：</span>
                    {techniques.length === 0 ? (
                      <span>全部内置技术</span>
                    ) : (
                      techniques.map((id) => {
                        const meta = agentEvalConfig.data?.techniques.find((t) => t.id === id);
                        return (
                          <Badge key={id} tone="info" className="ml-1">
                            {meta?.label ?? id}
                          </Badge>
                        );
                      })
                    )}
                  </div>
                  <div>
                    <span className="text-muted-foreground">自适应攻击：</span>
                    {adaptiveOverride.enabled ? '已启用' : '未启用'}
                  </div>
                </div>
              ))}

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                aria-label="保存为可复测样本库"
                checked={saveQuestionSet}
                onChange={(e) => setSaveQuestionSet(e.target.checked)}
              />
              <span>保存为可复测样本库</span>
            </label>

            <details className="rounded-xl border border-line bg-card text-sm">
              <summary className="cursor-pointer px-3 py-2 font-medium text-muted-foreground">
                查看技术细节（给专业人员）
              </summary>
              <div className="space-y-3 border-t border-border p-3">
                <div className="grid gap-3 sm:grid-cols-4">
                  <div>
                    <div className="text-xs text-muted-foreground">样本包版本</div>
                    <div className="mt-1 font-medium">{pack?.version ?? '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">更新时间</div>
                    <div className="mt-1">{formatDateTime(pack?.updatedAt)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">样本依据</div>
                    <div className="mt-1">{pack?.sourceRefs.join('、') || '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">样本类型数</div>
                    <div className="mt-1 tabular-nums">{pack?.templateCount ?? '—'}</div>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <Badge tone="info">
                    预计出题 {preview.data?.sampleCount ?? sampleCountValue} 道
                  </Badge>
                  <Badge tone="neutral">复现编号 {effectiveSeed}</Badge>
                  <Badge tone="neutral">一次测 {maxConcurrencyValue} 道</Badge>
                  {timeoutMsValue !== undefined && (
                    <Badge tone="neutral">每题最多等 {Math.round(timeoutMsValue / 1000)} 秒</Badge>
                  )}
                  {preview.isFetching && <span>正在刷新预览…</span>}
                </div>
              </div>
            </details>
          </div>
        )}
      </div>
    </Modal>
  );
}
