/** 标准条款主表的类型定义。数据见 clauses-*.ts，查询与判定见 catalog.ts。 */

/** 三条测评线。 */
export const EVAL_LINES = ['content', 'agent', 'endpoint'] as const;
export type EvalLine = (typeof EVAL_LINES)[number];

export const EVAL_LINE_LABELS: Record<EvalLine, string> = {
  content: '大模型内容安全',
  agent: '智能体应用安全',
  endpoint: '终端智能体安全',
};

/**
 * 条款性质：
 * - risk：风险类别（例如附录 A 的 31 项），结论是「发现风险 / 未发现风险」；
 * - method：评估方法或题库要求（例如附录 B 的题库规模、抽检合格率），结论是「符合 / 不符合」；
 * - control：防护措施或管理要求（例如高风险操作人工介入），结论是「符合 / 不符合」。
 */
export type ClauseKind = 'risk' | 'method' | 'control';

/** 测法自动化程度：auto 平台自动判定；semi 平台取证、人工确认；manual 只能人工填报或由被测方提供材料。 */
export type ClauseAutomation = 'auto' | 'semi' | 'manual';

/** 平台当前对该条款的测评能力（声明，随能力建设更新）。 */
export type ClauseCapability = 'covered' | 'partial' | 'not_covered' | 'not_applicable';

export const CLAUSE_CAPABILITY_LABELS: Record<ClauseCapability, string> = {
  covered: '平台可测',
  partial: '部分可测',
  not_covered: '平台暂不覆盖',
  not_applicable: '不适用于黑盒测评',
};

export type ClauseMetric =
  | 'pass_rate'
  | 'refusal_rate'
  | 'false_refusal_rate'
  | 'complied_rate'
  | 'bank_size';

export interface ClauseThreshold {
  metric: ClauseMetric;
  op: '>=' | '<=';
  value: number;
}

export interface StandardClause {
  /** 稳定编号，写入结果与报告，勿改。例如 gbt45654.A.2.e。 */
  id: string;
  /** 依据编号，见 bases.ts。 */
  basisId: string;
  /** 条款位置，例如「附录 A.2 e)」「8 g)」。没有可靠条款号时写章节名，并在 sourceRef 说明。 */
  ref: string;
  title: string;
  /** 一句话的可测要求。 */
  requirement: string;
  lines: readonly EvalLine[];
  kind: ClauseKind;
  automation: ClauseAutomation;
  capability: ClauseCapability;
  /** 能力边界或不覆盖的原因。capability 不是 covered 时必填。 */
  capabilityNote?: string;
  /** 判定所需的最少有效样本（risk 类按单项计）。 */
  minSamples?: number;
  threshold?: ClauseThreshold;
  /** 适用前提，例如「仅情感陪伴类服务」。 */
  applicability?: string;
  /** 原文出处与核对说明。 */
  sourceRef: string;
  /** 平台用于测这一条的能力或数据来源（模块、样本库、检查项），给维护人看。 */
  methods?: readonly string[];
}

/** 条款结论。 */
export type ClauseVerdict = 'conform' | 'nonconform' | 'insufficient' | 'not_tested' | 'not_applicable';

export interface ClauseObservation {
  clauseId: string;
  /** 有效判定数（不含无效、未执行）。 */
  tested: number;
  /** 不合格（发现风险、照做、不符合）的数量。 */
  failed: number;
  /** 无效或未执行的数量（不计入 tested）。 */
  invalid?: number;
  /** 人工或探针直接给出的结论（例如配置检查项），优先于计数推算。 */
  manualVerdict?: ClauseVerdict;
}

export interface ClauseResult {
  clause: StandardClause;
  verdict: ClauseVerdict;
  /** 结论的中文标签，risk 类与 method/control 类不同。 */
  label: string;
  tested: number;
  failed: number;
  invalid: number;
  /** 一句话说明结论怎么来的。 */
  note: string;
}
