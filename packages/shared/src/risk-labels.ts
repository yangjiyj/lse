/**
 * 风险类别 / 判定来源的共享中文表（页面、报告标签、报告摘要共用，同一个值只有一种说法）。
 *
 * 背景：引擎判词（llm_judge_fail、agent_llm_judge_fail 等）是「判定来源」，不是「风险类别」。
 * 历史数据里这些值被写进了 riskCategory 字段，展示层必须把它们当作来源处理：
 * - 「风险类别」列回退为样本的风险域；没有风险域时显示「未分类」；
 * - 判定来源的中文叫法只在这里定义一次。
 *
 * 注意：只新增、不删除本包内文件（现网叠加发布不支持删文件）。
 */

/** 无法确定风险类别时的统一展示。 */
export const UNCATEGORIZED_LABEL = '未分类';

/** 判定来源 → 中文。同一个值在页面、报告标签、报告摘要里只能是这一种说法。 */
export const JUDGE_SOURCE_LABELS: Readonly<Record<string, string>> = {
  llm_judge_pass: 'AI 评审复核通过',
  llm_judge_fail: 'AI 评审复核未通过',
  llm_judge_unknown: 'AI 评审复核未得出结论',
  llm_judge_incomplete: 'AI 评审复核未完成',
  agent_llm_judge_pass: '智能体行为判定通过',
  agent_llm_judge_fail: '智能体行为判定未通过',
  agent_llm_judge_unknown: '智能体行为判定未得出结论',
  agent_llm_judge_skipped: '智能体行为判定已跳过',
  python_judge_unavailable: 'AI 深度语义判定不可用',
  engine_error: '引擎执行错误',
};

/** 兼容旧代码里直接引用这两个值的位置。 */
export const LLM_JUDGE_FAIL_LABEL = JUDGE_SOURCE_LABELS['llm_judge_fail']!;
export const AGENT_LLM_JUDGE_FAIL_LABEL = JUDGE_SOURCE_LABELS['agent_llm_judge_fail']!;

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * 是否「判定来源」类的值（不是业务风险类别）：
 * llm_judge_*、agent_llm_judge_*、python_judge_*、engine_error。
 */
export function isJudgeSourceCategory(code: string | null | undefined): boolean {
  const c = (code ?? '').trim();
  if (!c) return false;
  return /^(?:agent_)?llm_judge/.test(c) || /^python_judge/.test(c) || c === 'engine_error';
}

/** 判定来源的中文说法；不是判定来源（或未收录）时返回 undefined。 */
export function judgeSourceLabel(code: string | null | undefined): string | undefined {
  const c = (code ?? '').trim();
  if (!c || !hasOwn(JUDGE_SOURCE_LABELS, c)) return undefined;
  return JUDGE_SOURCE_LABELS[c];
}

/**
 * 「风险类别」列的回退：判定来源不能当类别展示。
 * @param code 样本落库的 riskCategory
 * @param fallbackLabel 调用方已有的、样本所属风险域的中文名（有就用，没有则「未分类」）
 */
export function categoryOrFallback(
  code: string | null | undefined,
  categoryLabel: (code: string) => string,
  fallbackLabel?: string | null,
): string {
  const c = (code ?? '').trim();
  if (!c) return fallbackLabel?.trim() || UNCATEGORIZED_LABEL;
  if (isJudgeSourceCategory(c) || c === 'uncategorized') {
    return fallbackLabel?.trim() || UNCATEGORIZED_LABEL;
  }
  return categoryLabel(c);
}

/** 英文类别名 → 中文风险域名（用于任务对比等需要把中英文同义行合并的位置）。 */
export const ENGLISH_CATEGORY_ALIASES: Readonly<Record<string, string>> = {
  'hazardous materials': '危险物品',
  'illegal activities': '违法行为',
  'prompt injection': '提示注入',
  'indirect injection': '间接注入',
  'privacy compliance': '隐私合规',
  'bias and discrimination': '偏见歧视',
  'general knowledge': '通用能力',
  'logical reasoning': '逻辑推理',
  'cyber abuse': '网络滥用',
  'fraud and social engineering': '诈骗社工',
  'system prompt leakage': '系统提示泄露',
  'rag poisoning': 'RAG 污染',
  'output injection': '输出处理注入',
  'data exfiltration': '数据泄露',
  'misinformation and hallucination': '模型幻觉',
  'high-risk professional advice': '高风险专业建议',
  'model theft': '模型盗用',
  'resource exhaustion': '资源消耗',
  'training data extraction': '训练数据提取',
  'tool overreach': '工具越权',
  'internal network access': '内网访问',
};

/** 把英文类别名归一到中文；已是中文或未收录的原样返回。 */
export function normalizeCategoryName(name: string): string {
  const key = name.trim().toLowerCase().replace(/\s+/g, ' ');
  return hasOwn(ENGLISH_CATEGORY_ALIASES, key) ? ENGLISH_CATEGORY_ALIASES[key]! : name;
}

/** GB/T 45654 国标专项的 31 个风险类别键 → 中文名（界面不得露出英文类别码）。 */
export const STANDARD_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  politics: '政治安全',
  national_security: '国家安全',
  territorial_sovereignty: '领土主权',
  military: '军事',
  diplomacy: '外交',
  public_security: '公共安全',
  social_stability: '社会稳定',
  terrorism_extremism: '恐怖主义与极端主义',
  violence: '暴力',
  crime: '违法犯罪',
  drugs: '毒品',
  gambling: '赌博',
  pornography: '淫秽色情',
  minors: '未成年人保护',
  ethnicity: '民族问题',
  religion: '宗教信仰',
  historical_memory: '历史记忆',
  heroes_martyrs: '英烈保护',
  privacy_personal_information: '隐私与个人信息',
  fraud_social_engineering: '诈骗与社会工程',
  discrimination: '歧视',
  health: '健康医疗',
  finance: '金融合规',
  education: '学术诚信',
  professional_advice: '冒充专业人士',
  misinformation: '虚假信息',
  copyright: '知识产权',
  harmful_methods: '有害方法',
  animal_cruelty: '虐待动物',
  custom_regulatory: '自定义监管要求',
  other_illegal_harmful: '其他违法有害内容',
};

/** 国标专项「训练数据」限制常量 → 中文。 */
export const STANDARD_TRAINING_DATA_LABELS: Readonly<Record<string, string>> = {
  NOT_EVALUATED_API_ONLY: '训练数据：不评估（仅评估接口输出）',
};

/** 训练数据说明：已知常量走中文；未知值统一回退，绝不露出常量。 */
export function standardTrainingDataLabel(value: string | null | undefined): string {
  const v = (value ?? '').trim();
  if (!v) return '训练数据：不评估（仅评估接口输出）';
  if (hasOwn(STANDARD_TRAINING_DATA_LABELS, v)) return STANDARD_TRAINING_DATA_LABELS[v]!;
  return /[一-鿿]/.test(v) ? v : '训练数据：不评估（仅评估接口输出）';
}
