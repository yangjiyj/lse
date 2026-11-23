// 样本库分类展示用的常量与纯函数：种子库的来源/许可/用途映射、运行记录的来源类型。
// 许可与来源只写有把握的；没有把握的统一写「内置」，不要编造。
import {
  BANK_SOURCES,
  BUILTIN_TAXONOMIES,
  GENERATION_TOTAL_MIN,
  NON_REFUSAL_TOTAL_MIN,
  REFUSAL_TOTAL_MIN,
  builtinSetSource,
} from '@lse/shared';

export const LARGE_BANK_THRESHOLD = 10000;
export const LARGE_BANK_HINT = '规模较大，评估时请用「抽样题数」，不建议全量';

export interface SeedBankMeta {
  /** 来源与许可，一句话。 */
  provenance: string;
  /** 用途，一句话。 */
  purpose: string;
  /** 推荐用法，一句话。 */
  usage: string;
}

const DEFAULT_META: SeedBankMeta = {
  provenance: '平台内置 · 许可：内置',
  purpose: '平台内置的样本库，可直接作为评估样本来源。',
  usage: '创建评估任务时直接选用即可。',
};

const EXACT: Record<string, SeedBankMeta> = {
  'builtin:dataset:safety-prompts': {
    provenance: '清华大学 CoAI 小组 Safety-Prompts · 许可：Apache-2.0',
    purpose: '中文大模型安全评估大规模数据集，覆盖多类安全场景与指令攻击。',
    usage: '评估时按「抽样题数」抽取几百题做摸底，不建议全量运行。',
  },
  'builtin:compliance:tc260': {
    provenance: 'GB/T 45654-2025 附录 A 对应样本库 · 许可：内置',
    purpose: '按 GB/T 45654-2025 附录 A 的 5 大类 31 项风险组织的样本库，用于逐项检查。',
    usage: '按附录 A 逐项摸底时整库选用，可在「GB/T 45654-2025 附录 A」页签中按小类浏览；题量尚未达到附录 B 的题库规模要求。',
  },
};

const PREFIX: Array<[string, SeedBankMeta]> = [
  [
    'builtin:mcp:',
    {
      provenance: 'MCP 专项样本库 · 许可：内置',
      purpose: '针对 MCP 工具调用链路的专项安全样本。',
      usage: '评估接入了 MCP 工具的智能体时选用。',
    },
  ],
  [
    'builtin:red-team',
    {
      provenance: '红队候选包 · 许可：内置',
      purpose: '供自主红队评估使用的攻击候选样本包，按标准版/深度版分档。',
      usage: '做红队评估时按档位选用，通常无需单独管理。',
    },
  ],
  [
    'benchmark:',
    {
      provenance: '平台评估基准样例 · 许可：内置',
      purpose: '平台自带的评估基准样例集，便于快速演示和验证流程。',
      usage: '首次试用或演示时选用，小规模、跑得快。',
    },
  ],
];

export function seedBankMeta(source: string | null | undefined): SeedBankMeta {
  if (!source) return DEFAULT_META;
  if (EXACT[source]) return EXACT[source];
  const hit = PREFIX.find(([p]) => source.startsWith(p));
  return hit ? hit[1] : DEFAULT_META;
}

/** 覆盖风险取不到具体类别时的兜底文案。 */
export const COVERAGE_FALLBACK = '覆盖多类风险';
const GENERIC_COVERAGE = '通用安全风险';

/**
 * 种子库卡片的「覆盖风险」标签。
 * - 内置合规/数据集样本库：用其分类体系的大类名（去掉“A.1 ”这类编号），这是实际覆盖的类别；
 * - 其余：沿用后端按题目分类统计出的覆盖面；
 * - 只剩单个「通用安全风险」或为空时，说明没有可展示的具体类别，统一写「覆盖多类风险」。
 */
export function seedBankCoverage(
  source: string | null | undefined,
  riskCoverage: string[] | undefined,
): string[] {
  const taxonomy = source
    ? BUILTIN_TAXONOMIES.find((t) => builtinSetSource(t.id) === source)
    : undefined;
  // 只有一个大类的体系（信通院、能源、通用场景）没有区分度，交给后端统计或兜底文案。
  if (taxonomy && taxonomy.majors.length > 1) {
    return taxonomy.majors.map((major) => major.name.replace(/^[A-Z]+\.\d+\s+/, ''));
  }
  const specific = (riskCoverage ?? []).filter((tag) => tag && tag !== GENERIC_COVERAGE);
  return specific.length ? specific : [COVERAGE_FALLBACK];
}

export const isLargeBank = (questionCount: number) => questionCount > LARGE_BANK_THRESHOLD;

/** 种子库按用途分组：国标合规检测题库 / 对抗演练种子 / 可选题源。 */
export type SeedBankGroupId = 'gbt' | 'red-team' | 'optional';

export const SEED_BANK_GROUPS: ReadonlyArray<{ id: SeedBankGroupId; title: string }> = [
  { id: 'gbt', title: '国标合规检测题库' },
  { id: 'red-team', title: '对抗演练种子' },
  { id: 'optional', title: '可选题源' },
];

/** 按 source 前缀分组；认不出的来源一律归可选题源。 */
export function seedBankGroup(source: string | null | undefined): SeedBankGroupId {
  if (source?.startsWith('builtin:gbt45654')) return 'gbt';
  if (source?.startsWith('builtin:red-team')) return 'red-team';
  return 'optional';
}

/** 国标三个题库在附录 B 里的规模要求（题数），也是组内的排列顺序。 */
const GBT_REQUIREMENTS: ReadonlyArray<[string, number]> = [
  [BANK_SOURCES.generation, GENERATION_TOTAL_MIN],
  [BANK_SOURCES.refusal, REFUSAL_TOTAL_MIN],
  [BANK_SOURCES.non_refusal, NON_REFUSAL_TOTAL_MIN],
];

/** 国标三个题库的卡片短名：组标题已写明国标合规检测题库，卡片只写是哪个库，三张一行时不折行。 */
const GBT_SHORT_NAMES: Record<string, string> = {
  [BANK_SOURCES.generation]: '生成内容测试题库',
  [BANK_SOURCES.refusal]: '应拒答测试题库',
  [BANK_SOURCES.non_refusal]: '非拒答测试题库',
};

export function seedBankTitle(name: string, source: string | null | undefined): string {
  return (source && GBT_SHORT_NAMES[source]) || name;
}

export function gbtBankRequirement(source: string | null | undefined): number | null {
  return GBT_REQUIREMENTS.find(([s]) => s === source)?.[1] ?? null;
}

/** 国标组内按生成内容、应拒答、非拒答排序；其他来源排在后面，保持原顺序。 */
export function gbtBankOrder(source: string | null | undefined): number {
  const i = GBT_REQUIREMENTS.findIndex(([s]) => s === source);
  return i < 0 ? GBT_REQUIREMENTS.length : i;
}

/** 运行记录来源类型（与后端 kind.ts 的 RUN_SOURCE_PREFIXES 对应）。 */
export const RUN_SOURCE_TYPES: Array<{ id: string; label: string; prefix: string }> = [
  { id: 'red-team', label: '红队攻击', prefix: 'red-team' },
  { id: 'comprehensive', label: '综合评估', prefix: 'comprehensive:' },
  { id: 'generator', label: '样本生成', prefix: 'generator:' },
  { id: 'agent-runtime', label: '智能体运行时', prefix: 'agent-runtime:' },
  { id: 'endpoint-agent', label: '终端智能体', prefix: 'endpoint-agent-v1' },
  { id: 'multimodal', label: '多模态越狱', prefix: 'multimodal-jailbreak' },
  { id: 'custom-risk', label: '自定义风险测试', prefix: 'custom-risk-fuzz' },
  { id: 'fanout', label: '并行评估', prefix: 'fanout:' },
  { id: 'assurance', label: '保障环', prefix: 'assurance' },
  { id: 'observed', label: '智能体真实观测', prefix: '平台智能体真实观测' },
  { id: 'acceptance', label: '验收测试', prefix: '验收测试' },
];

export const RUN_TYPE_OTHER = { id: 'other', label: '验收 / 发布验证' };

export function runSourceType(source: string | null | undefined): { id: string; label: string } {
  const s = source?.trim() ?? '';
  const hit = s ? RUN_SOURCE_TYPES.find((t) => s.startsWith(t.prefix)) : undefined;
  return hit ? { id: hit.id, label: hit.label } : RUN_TYPE_OTHER;
}
