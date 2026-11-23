import { usePlatformAppEnabled } from '@/lib/use-platform-app-enabled';
import { isContentEvalTarget } from '@/lib/eval-targets';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, PlayCircle, SlidersHorizontal } from 'lucide-react';
import { api, ApiError, type ModelTarget } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Modal } from '@/components/ui/modal';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';

type ContentSafetyLevel = 'smoke' | 'standard' | 'deep';
type ContentSafetyFocusId =
  | 'data_security'
  | 'content_compliance'
  | 'prompt_injection'
  | 'refusal'
  | 'cyber_abuse'
  | 'fraud_social_engineering'
  | 'rag_knowledge'
  | 'model_reliability'
  | 'professional_advice'
  | 'model_security'
  | 'robustness';

interface ContentSafetyOption {
  level: ContentSafetyLevel;
  label: string;
  sampleCount: number;
  description: string;
  scenario: string;
}

const CONTENT_SAFETY_OPTIONS: ContentSafetyOption[] = [
  {
    level: 'smoke',
    label: '快速验证',
    sampleCount: 24,
    description: '基础内容安全 · 快速核验',
    scenario: '适用于模型接入后的拒答与敏感信息链路核验',
  },
  {
    level: 'standard',
    label: '标准评估',
    sampleCount: 80,
    description: '上线前常规覆盖',
    scenario: '覆盖拒答边界、提示注入、敏感信息、网络滥用、社会工程、检索增强污染和事实可靠性风险',
  },
  {
    level: 'deep',
    label: '深度对抗',
    sampleCount: 200,
    description: '多语言多变体 · 扩展覆盖',
    scenario: '适用于重点模型上线前的多语言、多变体、多风险域评估与策略回归',
  },
];

const CONTENT_TYPES = ['SHOULD_REFUSE', 'COMPLIANCE', 'PROMPT_INJECTION', 'GENERAL'];
const CONTENT_CATEGORIES = [
  '危险物品',
  '违法行为',
  '网络滥用',
  '诈骗与社会工程',
  '隐私合规',
  '数据泄露',
  '偏见歧视',
  '高风险专业建议',
  '提示注入',
  '间接注入',
  '系统提示泄露',
  'RAG 污染',
  '输出处理注入',
  '训练数据提取',
  '模型盗用',
  '资源消耗',
  '工具越权',
  '内网访问',
  '模型幻觉',
  '通用能力',
  '逻辑推理',
  'Hazardous Materials',
  'Illegal Activities',
  'Cyber Abuse',
  'Fraud and Social Engineering',
  'Privacy Compliance',
  'Bias and Discrimination',
  'High-Risk Professional Advice',
  'Prompt Injection',
  'Indirect Injection',
  'System Prompt Leakage',
  'RAG Poisoning',
  'Output Injection',
  'Data Exfiltration',
  'Training Data Extraction',
  'Model Theft',
  'Resource Exhaustion',
  'Tool Overreach',
  'Internal Network Access',
  'Misinformation and Hallucination',
  'General Knowledge',
  'Logical Reasoning',
];
const CONTENT_ENGINES = ['rule-judge', 'sensitive-info'];
const CONTENT_DIMENSIONS = [
  'compliance',
  'refusal',
  'prompt_injection',
  'sensitive_info',
  'privacy_leakage',
  'cyber_abuse',
  'fraud_social_engineering',
  'system_prompt_leakage',
  'training_data_extraction',
  'rag_data_poisoning',
  'agent_tool_abuse',
  'data_exfiltration',
  'ssrf_network_access',
  'output_injection',
  'misinformation_hallucination',
  'unsafe_professional_advice',
  'bias_discrimination',
  'model_denial_of_service',
  'model_theft',
  'robustness',
];

const CONTENT_FOCUS_OPTIONS: Array<{
  id: ContentSafetyFocusId;
  label: string;
  description: string;
  types: string[];
  categories: string[];
  dimensions: string[];
}> = [
  {
    id: 'data_security',
    label: '数据安全',
    description: '个人信息、密钥、业务数据泄露与越权披露。',
    types: ['SHOULD_REFUSE', 'COMPLIANCE'],
    categories: ['隐私合规', '数据泄露', '敏感信息保护'],
    dimensions: ['sensitive_info', 'privacy_leakage', 'compliance'],
  },
  {
    id: 'content_compliance',
    label: '内容合规',
    description: '违法违规、行业合规、未成年人保护和公平性。',
    types: ['COMPLIANCE', 'SHOULD_REFUSE'],
    categories: ['危险物品', '违法行为', '行业合规', '未成年人保护', '偏见歧视'],
    dimensions: ['compliance', 'refusal', 'bias_discrimination'],
  },
  {
    id: 'prompt_injection',
    label: '提示注入',
    description: '评估模型是否执行越权指令、泄露系统设定，或服从外部内容中的间接指令。',
    types: ['PROMPT_INJECTION'],
    categories: ['提示注入', '间接注入', '越狱绕过', '系统提示泄露'],
    dimensions: ['prompt_injection', 'system_prompt_leakage', 'robustness'],
  },
  {
    id: 'refusal',
    label: '拒答能力',
    description: '应拒绝场景下的未有效拒绝、危险能力请求和违法协助。',
    types: ['SHOULD_REFUSE'],
    categories: ['危险物品', '违法行为', '网络滥用', '诈骗与社会工程'],
    dimensions: ['refusal', 'harmful_capability', 'compliance'],
  },
  {
    id: 'cyber_abuse',
    label: '网络滥用',
    description: '恶意代码、凭据攻击、绕过认证和未授权访问。',
    types: ['SHOULD_REFUSE', 'COMPLIANCE'],
    categories: ['网络滥用', '恶意代码', '凭据攻击'],
    dimensions: ['cyber_abuse', 'refusal'],
  },
  {
    id: 'fraud_social_engineering',
    label: '诈骗与社会工程',
    description: '钓鱼诱导、冒充身份、转账验证码和欺骗话术。',
    types: ['SHOULD_REFUSE', 'COMPLIANCE'],
    categories: ['诈骗与社会工程', '钓鱼诱导', '冒充身份'],
    dimensions: ['fraud_social_engineering', 'refusal', 'compliance'],
  },
  {
    id: 'rag_knowledge',
    label: 'RAG / 知识库',
    description: '评估检索增强场景中的污染内容是否导致错误回答、危险输出或间接提示注入。',
    types: ['PROMPT_INJECTION', 'COMPLIANCE'],
    categories: ['RAG 污染', '间接注入', '数据泄露'],
    dimensions: ['rag_data_poisoning', 'prompt_injection', 'data_exfiltration'],
  },
  {
    id: 'model_reliability',
    label: '模型幻觉',
    description: '评估证据不足时的事实编造、误导性结论和前后矛盾。',
    types: ['GENERAL', 'COMPLIANCE'],
    categories: ['模型幻觉', '事实一致性', '通用能力'],
    dimensions: ['misinformation_hallucination', 'robustness'],
  },
  {
    id: 'professional_advice',
    label: '高风险建议',
    description: '医疗、法律、金融、心理等高风险专业决策。',
    types: ['COMPLIANCE', 'SHOULD_REFUSE'],
    categories: ['高风险专业建议', '行业合规'],
    dimensions: ['unsafe_professional_advice', 'compliance', 'refusal'],
  },
  {
    id: 'model_security',
    label: '模型与资源安全',
    description: '评估训练数据提取、模型盗用、资源耗尽和输出篡改风险。',
    types: ['PROMPT_INJECTION', 'GENERAL'],
    categories: ['训练数据提取', '模型盗用', '资源消耗', '输出处理注入'],
    dimensions: [
      'training_data_extraction',
      'model_theft',
      'model_denial_of_service',
      'output_injection',
    ],
  },
  {
    id: 'robustness',
    label: '输出鲁棒性',
    description: '评估边界条件、诱导性输入和格式混淆导致的不稳定或错误输出。',
    types: ['GENERAL', 'COMPLIANCE'],
    categories: ['通用能力', '逻辑推理', '边界问题'],
    dimensions: ['robustness', 'compliance'],
  },
];

const DEFAULT_CONTENT_FOCUS_IDS: ContentSafetyFocusId[] = [
  'data_security',
  'content_compliance',
  'prompt_injection',
];

interface ContentSafetyEvalModalProps {
  initialTargetId?: string;
  open: boolean;
  onClose: () => void;
}

function contentSafetyOption(level: ContentSafetyLevel): ContentSafetyOption {
  return CONTENT_SAFETY_OPTIONS.find((item) => item.level === level) ?? CONTENT_SAFETY_OPTIONS[1]!;
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values)];
}

function executableTarget(target: ModelTarget, platformAppEnabled = false): boolean {
  return isContentEvalTarget(target, platformAppEnabled);
}

function targetOptionLabel(target: ModelTarget): string {
  if (target.targetType === 'AGENT_API') return `${target.name}（评估对象）`;
  return `${target.name}（${target.model}）`;
}

function ContentSafetyStrengthControl({
  value,
  onChange,
  disabled,
  standardCount,
}: {
  value: ContentSafetyLevel;
  onChange: (value: ContentSafetyLevel) => void;
  disabled?: boolean;
  standardCount?: number;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-3" role="group" aria-label="内容安全评估强度">
      {CONTENT_SAFETY_OPTIONS.map((option) => {
        const active = option.level === value;
        return (
          <button
            key={option.level}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() => onChange(option.level)}
            className={cn(
              'min-h-[116px] rounded-xl border border-line bg-card p-3 text-left transition-colors hover:border-primary/60 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
              active && 'border-primary bg-primary/5 ring-1 ring-primary/30',
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-foreground">{option.label}</span>
            </div>
            <div className="mt-2 text-xs font-medium text-foreground">{option.description}</div>
            {option.level === 'standard' && standardCount !== undefined ? (
              <div className="mt-1 text-xs text-primary">单次评估题数 {standardCount} 题</div>
            ) : null}
            <div className="mt-1 text-xs leading-5 text-muted-foreground">{option.scenario}</div>
          </button>
        );
      })}
    </div>
  );
}

export function ContentSafetyEvalModal({
  open,
  onClose,
  initialTargetId,
}: ContentSafetyEvalModalProps) {
  const platformAppEnabled = usePlatformAppEnabled();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [modelTargetId, setModelTargetId] = useState('');
  // 多模型同批次对比：同一批样本对多个模型各建一个任务。
  const [multiModel, setMultiModel] = useState(false);
  const [batchModelIds, setBatchModelIds] = useState<string[]>([]);
  useEffect(() => {
    if (open && initialTargetId) setModelTargetId(initialTargetId);
  }, [open, initialTargetId]);
  const [level, setLevel] = useState<ContentSafetyLevel>('standard');
  const [advanced, setAdvanced] = useState(false);
  const sampleCountEdited = useRef(false);
  const [sampleCount, setSampleCount] = useState(
    String(contentSafetyOption('standard').sampleCount),
  );
  const [seed, setSeed] = useState('');
  const [concurrency, setConcurrency] = useState('4');
  const [focusIds, setFocusIds] = useState<ContentSafetyFocusId[]>([...DEFAULT_CONTENT_FOCUS_IDS]);

  const selectedStrength = contentSafetyOption(level);
  // 配置管理「单次评估题数」：作为标准评估的默认样本数（未配置时沿用 80）。
  const evaluationConfig = useQuery({
    queryKey: ['evaluation-config'],
    queryFn: () => api.evaluationConfig.get(),
    enabled: open,
  });
  const standardCount =
    evaluationConfig.data?.questionCount ?? contentSafetyOption('standard').sampleCount;
  const optionCount = (l: ContentSafetyLevel) =>
    l === 'standard' ? standardCount : contentSafetyOption(l).sampleCount;
  const selectedCount = optionCount(level);
  const models = useQuery({
    queryKey: ['model-targets', 'active-for-content-safety-eval'],
    queryFn: () => api.modelTargets.list({ page: 1, pageSize: 100 }),
    enabled: open,
  });

  const selectedModel = useMemo(
    () => models.data?.items.find((item) => item.id === modelTargetId) ?? null,
    [modelTargetId, models.data?.items],
  );

  const sampleCountValue = useMemo(() => {
    const parsed = Number(sampleCount);
    if (!Number.isFinite(parsed)) return selectedCount;
    return parsed;
  }, [sampleCount, selectedCount]);

  const concurrencyValue = useMemo(() => {
    const parsed = Math.floor(Number(concurrency));
    if (!Number.isFinite(parsed)) return 4;
    return Math.max(1, Math.min(32, parsed));
  }, [concurrency]);

  const selectedFocusOptions = useMemo(() => {
    const selected = CONTENT_FOCUS_OPTIONS.filter((option) => focusIds.includes(option.id));
    return selected.length > 0 ? selected : CONTENT_FOCUS_OPTIONS;
  }, [focusIds]);
  const contentTypes = useMemo(
    () =>
      advanced
        ? uniqueValues(selectedFocusOptions.flatMap((item) => item.types))
        : [...CONTENT_TYPES],
    [advanced, selectedFocusOptions],
  );
  const contentCategories = useMemo(
    () =>
      advanced
        ? uniqueValues(selectedFocusOptions.flatMap((item) => item.categories))
        : [...CONTENT_CATEGORIES],
    [advanced, selectedFocusOptions],
  );
  const contentDimensions = useMemo(
    () =>
      advanced
        ? uniqueValues(selectedFocusOptions.flatMap((item) => item.dimensions))
        : [...CONTENT_DIMENSIONS],
    [advanced, selectedFocusOptions],
  );
  const focusLabelText = selectedFocusOptions.map((item) => item.label).join('、');

  const reset = () => {
    sampleCountEdited.current = false;
    setModelTargetId('');
    setLevel('standard');
    setAdvanced(false);
    setSampleCount(String(contentSafetyOption('standard').sampleCount));
    setSeed('');
    setConcurrency('4');
    setFocusIds([...DEFAULT_CONTENT_FOCUS_IDS]);
  };

  useEffect(() => {
    if (!open) reset();
  }, [open]);

  const changeLevel = (next: ContentSafetyLevel) => {
    sampleCountEdited.current = false;
    setLevel(next);
    setSampleCount(String(optionCount(next)));
  };

  useEffect(() => {
    if (level === 'standard' && !sampleCountEdited.current) setSampleCount(String(standardCount));
    // 仅在配置加载完成（题数变化）时同步标准评估的默认样本数
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [standardCount]);

  const toggleFocus = (id: ContentSafetyFocusId) => {
    setFocusIds((prev) => {
      if (prev.includes(id)) return prev.length === 1 ? prev : prev.filter((item) => item !== id);
      return [...prev, id];
    });
  };

  const runMutation = useMutation({
    mutationFn: async () => {
      const modelName = multiModel
        ? `${batchModelIds.length} 个模型`
        : (selectedModel?.name ?? '评估对象');
      const taskName = `${modelName} 内容安全评估 ${new Date().toLocaleString('zh-CN', {
        hour12: false,
      })}`;
      const trimmedSeed = seed.trim();
      const generateBody: Parameters<typeof api.generator.generate>[0] = {
        name: `${taskName} 样本`,
        description: advanced
          ? `自动生成内容安全样本：强度 ${selectedStrength.label}，重点方向 ${focusLabelText}。`
          : `自动生成内容安全样本：强度 ${selectedStrength.label}，覆盖拒答、合规、注入、数据泄露、网络滥用、诈骗社工、RAG 污染、幻觉和模型资源安全。`,
        types: contentTypes,
        categories: contentCategories,
        language: 'auto',
        count: sampleCountValue,
        variantStrength: 'auto',
        dedupe: true,
      };
      if (advanced && trimmedSeed) generateBody.seed = trimmedSeed;

      const generated = await api.generator.generate(generateBody);
      if (multiModel) {
        const batch = await api.evalTasks.createBatch({
          name: taskName,
          description: `自动生成 ${generated.produced} 个内容安全样本；多模型同批次对比。`,
          modelTargetIds: batchModelIds,
          questionSetIds: [generated.questionSetId],
          engines: [...CONTENT_ENGINES],
          dimensions: contentDimensions,
          concurrency: concurrencyValue,
        });
        return { batchId: batch.batchId };
      }
      return api.evalTasks.create({
        name: taskName,
        description: advanced
          ? `自动生成 ${generated.produced} 个内容安全样本；重点检查 ${focusLabelText}。`
          : `自动生成 ${generated.produced} 个内容安全样本；覆盖拒答边界、数据泄露、提示注入、网络滥用、社会工程、检索增强污染、事实可靠性和模型资源安全风险。`,
        modelTargetId,
        questionSetIds: [generated.questionSetId],
        engines: [...CONTENT_ENGINES],
        dimensions: contentDimensions,
        concurrency: concurrencyValue,
      });
    },
    onSuccess: (task) => {
      qc.invalidateQueries({ queryKey: ['eval-tasks'] });
      onClose();
      if ('batchId' in task) {
        toast.success('多模型同批次评估已开始，可在对比分析中查看各模型结果');
        navigate(`/eval-tasks/compare?batchId=${task.batchId}`);
        return;
      }
      toast.success('内容安全评估已开始，可在任务详情中查看进度与结果');
      navigate(`/eval-tasks/${task.id}`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '内容安全评估启动失败'),
  });

  const canSubmit =
    (multiModel ? batchModelIds.length >= 2 : Boolean(modelTargetId)) &&
    Number.isInteger(sampleCountValue) &&
    sampleCountValue >= 1 &&
    sampleCountValue <= 2000 &&
    !runMutation.isPending;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="发起内容安全评估"
      description="选择评估对象和评估强度。平台将自动生成测试样本，并记录响应、判定与风险证据。"
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
        <div className="rounded-xl border border-brand-100 bg-brand-50/70 px-4 py-3 text-[13px] leading-6 text-ink-2">
          平台将生成覆盖内容合规、提示注入、数据泄露、社会工程和事实可靠性等风险域的测试样本。
          <br />
          评估使用平台生成的测试数据；完成后可在任务详情查看结论、证据和处置建议。
        </div>

        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={multiModel}
            onChange={(event) => setMultiModel(event.target.checked)}
          />
          多模型同批次对比（同一批样本同时评估多个模型）
        </label>

        {multiModel ? (
          <fieldset
            aria-label="评估模型（多选）"
            className="space-y-1.5 rounded-xl border border-slate-200 p-3"
          >
            <legend className="px-1 text-sm font-medium">评估模型（至少选择 2 个）</legend>
            {models.data?.items
              .filter((target) => executableTarget(target, platformAppEnabled))
              .map((item) => (
                <label key={item.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={batchModelIds.includes(item.id)}
                    onChange={(event) =>
                      setBatchModelIds((prev) =>
                        event.target.checked
                          ? [...prev, item.id]
                          : prev.filter((id) => id !== item.id),
                      )
                    }
                  />
                  {targetOptionLabel(item)}
                </label>
              ))}
            <p className="text-xs text-muted-foreground">
              已选 {batchModelIds.length} 个；每个模型各建一个评估任务，完成后进入多模型对比分析。
            </p>
          </fieldset>
        ) : null}

        <Field
          label="评估对象"
          htmlFor="content-safety-model"
          required
          className={multiModel ? 'hidden' : undefined}
        >
          <Select
            id="content-safety-model"
            aria-label="评估对象"
            value={modelTargetId}
            onChange={(event) => setModelTargetId(event.target.value)}
          >
            <option value="">请选择评估对象…</option>
            {models.data?.items
              .filter((target) => executableTarget(target, platformAppEnabled))
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {targetOptionLabel(item)}
                </option>
              ))}
          </Select>
          {models.isSuccess &&
            (models.data?.items.filter((target) => executableTarget(target, platformAppEnabled))
              .length ?? 0) === 0 && (
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-[#F7F9FD] px-3 py-2">
                <p className="text-xs text-muted-foreground">
                  暂无可用评估对象，请先完成对象接入并启用。
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    onClose();
                    navigate('/model-targets');
                  }}
                >
                  前往评估对象
                </Button>
              </div>
            )}
        </Field>

        <div className="space-y-2" aria-label="内容安全自动覆盖范围">
          <p className="text-xs text-muted-foreground">默认风险覆盖范围：</p>
          <div className="flex flex-wrap gap-2">
            <Badge tone="critical" title="评估应拒答请求是否得到安全处置">
              拒答边界
            </Badge>
            <Badge tone="warning" title="评估违法违规和业务合规风险">
              内容合规
            </Badge>
            <Badge tone="info" title="评估越权指令执行、系统设定泄露和间接提示注入">
              提示注入
            </Badge>
            <Badge tone="danger" title="评估个人信息、凭据和业务数据泄露">
              数据泄露
            </Badge>
            <Badge tone="critical" title="评估恶意代码、认证绕过和未授权访问">
              网络滥用
            </Badge>
            <Badge tone="warning" title="评估诈骗、钓鱼和身份冒充内容">
              社会工程
            </Badge>
            <Badge tone="info" title="评估污染内容导致的错误回答、危险输出或间接注入">
              检索增强污染
            </Badge>
            <Badge tone="neutral" title="评估事实编造、误导性结论和前后矛盾">
              事实可靠性
            </Badge>
          </div>
        </div>

        <Field
          label="样本总数"
          htmlFor="content-safety-sample-count"
          hint="平台自动生成样本，可填写 1–2000 条；上限 2000 条，无需先选题库。"
        >
          <Input
            id="content-safety-sample-count"
            aria-label="样本总数"
            type="number"
            min={1}
            max={2000}
            value={sampleCount}
            onChange={(event) => {
              sampleCountEdited.current = true;
              setSampleCount(event.target.value);
            }}
          />
        </Field>
        {(!Number.isInteger(sampleCountValue) ||
          sampleCountValue < 1 ||
          sampleCountValue > 2000) && (
          <p role="alert" className="text-sm text-destructive">
            样本总数须为 1–2000 的整数。
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-[#F7F9FD] px-3 py-2">
          <div className="text-xs text-muted-foreground">
            <span className="block">
              平台自动生成并执行测试样本。标准强度通常需要十余分钟，完成后可查看结论、证据和处置建议。
            </span>
            <span className="mt-1 block text-xs text-muted-foreground/80">
              默认使用标准强度并覆盖全部风险域；可直接填写样本总数，高级配置可调整评估强度和重点范围。
            </span>
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
          <div className="grid gap-4 rounded-xl border border-line p-4 sm:grid-cols-3">
            <div className="sm:col-span-3">
              <Field label="评估强度" required>
                <ContentSafetyStrengthControl
                  standardCount={standardCount}
                  value={level}
                  onChange={changeLevel}
                  disabled={runMutation.isPending}
                />
              </Field>
            </div>
            <div className="space-y-3 rounded-xl border border-line bg-[#F7F9FD] p-3 sm:col-span-3">
              <div>
                <div className="text-sm font-medium text-foreground">重点方向</div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  默认随机生成全域样本；只有在这里勾选后，才会把生成样本聚焦到指定方向。
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {CONTENT_FOCUS_OPTIONS.map((option) => (
                  <label
                    key={option.id}
                    className="flex min-h-[76px] cursor-pointer gap-2 rounded-xl border border-line bg-card p-3 text-sm hover:bg-[#F7F9FD]"
                  >
                    <input
                      type="checkbox"
                      aria-label={option.label}
                      checked={focusIds.includes(option.id)}
                      onChange={() => toggleFocus(option.id)}
                      disabled={runMutation.isPending}
                      className="mt-0.5 h-4 w-4 shrink-0"
                    />
                    <span>
                      <span className="block font-medium text-foreground">{option.label}</span>
                      <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                        {option.description}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <Field label="复测种子" htmlFor="content-safety-seed" hint="留空则由后端生成">
              <Input
                id="content-safety-seed"
                aria-label="复测种子"
                value={seed}
                onChange={(event) => setSeed(event.target.value)}
                placeholder="自动生成"
              />
            </Field>
            <Field label="并发数" htmlFor="content-safety-concurrency" hint="1-32">
              <Input
                id="content-safety-concurrency"
                aria-label="并发数"
                type="number"
                min={1}
                max={32}
                value={concurrency}
                onChange={(event) => setConcurrency(event.target.value)}
              />
            </Field>
          </div>
        )}
      </div>
    </Modal>
  );
}
