import { normalizeSeverity, parseTags, QUESTION_TYPE } from '@lse/shared';
import type { Severity, QuestionType } from '@lse/shared';
import type {
  BenchmarkAdapter,
  RawRecord,
  MapRecordResult,
  MapIssue,
  NormalizedBenchmarkItem,
} from './types.js';

// 字段名归一化：去空白/下划线/连字符并小写，使 "3-category" / "3_category" / "3Category" 等价。
export function normKey(k: string): string {
  return k
    .trim()
    .toLowerCase()
    .replace(/[\s_\-]/g, '');
}

type Lookup = Map<string, string>;

function buildLookup(rec: RawRecord): Lookup {
  const m: Lookup = new Map();
  for (const [k, v] of Object.entries(rec)) {
    const nk = normKey(k);
    if (!m.has(nk)) m.set(nk, v); // 首个同名键优先
  }
  return m;
}

// 按别名顺序取第一个非空字段值（已 trim）。
function pick(lookup: Lookup, aliases: string[]): string {
  for (const a of aliases) {
    const v = lookup.get(normKey(a));
    if (v != null && v.trim() !== '') return v.trim();
  }
  return '';
}

function dedup(arr: string[]): string[] {
  return [...new Set(arr.map((s) => s.trim()).filter((s) => s !== ''))];
}

const TYPE_BY_NORM: Record<string, QuestionType> = {};
for (const t of QUESTION_TYPE) TYPE_BY_NORM[normKey(t)] = t;

function mapType(raw: string): QuestionType | null {
  return TYPE_BY_NORM[normKey(raw)] ?? null;
}

const TRUE_TOKENS = new Set([
  'true',
  '1',
  'yes',
  'y',
  '是',
  'refuse',
  'shouldrefuse',
  '拒答',
  '应拒答',
]);
function parseBool(raw: string): boolean {
  return TRUE_TOKENS.has(raw.trim().toLowerCase());
}

const MISSING_CONTENT: MapIssue = { level: 'error', message: '缺少必填的问题内容' };

// ---- SALAD-Bench（OpenSafetyLab）：JSON 数组，三级危害分类 ----
const saladBench: BenchmarkAdapter = {
  id: 'salad-bench',
  label: 'SALAD-Bench（OpenSafetyLab）',
  description:
    '适配 SALAD-Bench JSON 字段（qid/question/1~3-category/source），归一化为应拒答题目。仅适配格式，不内置数据集内容（许可证为研究用途）。',
  inputKind: 'json',
  mapRecord(rec): MapRecordResult {
    const lookup = buildLookup(rec);
    const content = pick(lookup, ['question', 'prompt', 'augq', 'baseq', 'aug_q', 'base_q']);
    if (!content) return { item: null, issues: [MISSING_CONTENT] };
    const c1 = pick(lookup, ['1-category', 'category1']);
    const c2 = pick(lookup, ['2-category', 'category2']);
    const c3 = pick(lookup, ['3-category', 'category3']);
    const source = pick(lookup, ['source']);
    const qid = pick(lookup, ['qid', 'id']);
    const item: NormalizedBenchmarkItem = {
      externalId: qid || null,
      content,
      category: c3 || c2 || c1 || null,
      expectedBehavior: null,
      referenceAnswer: null,
      severity: null,
      tags: dedup([c1, c2, c3, source]),
      type: 'SHOULD_REFUSE',
      shouldRefuse: true,
    };
    return { item, issues: [] };
  },
};

// ---- JADE-DB（复旦白盒）：CSV，问题/违规类型 ----
const jadeDb: BenchmarkAdapter = {
  id: 'jade-db',
  label: 'JADE-DB（复旦白盒越狱）',
  description:
    '适配 JADE-DB 中文 CSV（问题/违规类型），归一化为应拒答题目。仅适配格式，不内置数据集内容。',
  inputKind: 'csv',
  mapRecord(rec): MapRecordResult {
    const lookup = buildLookup(rec);
    const content = pick(lookup, ['问题', 'question', 'prompt', 'query', '指令']);
    if (!content) return { item: null, issues: [MISSING_CONTENT] };
    const violation = pick(lookup, ['违规类型', '类型', 'category', 'unsafe_type', '违规']);
    const item: NormalizedBenchmarkItem = {
      externalId: pick(lookup, ['id', 'qid', '编号']) || null,
      content,
      category: violation || null,
      expectedBehavior: null,
      referenceAnswer: null,
      severity: null,
      tags: dedup([violation]),
      type: 'SHOULD_REFUSE',
      shouldRefuse: true,
    };
    return { item, issues: [] };
  },
};

// ---- 通用映射（自带数据集 JSONL / CSV 共用，宽松别名） ----
function genericMap(rec: RawRecord): MapRecordResult {
  const lookup = buildLookup(rec);
  const issues: MapIssue[] = [];
  const content = pick(lookup, [
    'content',
    'prompt',
    'question',
    'query',
    'text',
    'instruction',
    '问题',
    '内容',
    '指令',
  ]);
  if (!content) return { item: null, issues: [MISSING_CONTENT] };

  const category =
    pick(lookup, ['category', 'risk', 'risktype', 'topic', '类别', '分类', '违规类型', '类型']) ||
    null;

  const sevRaw = pick(lookup, ['severity', 'level', 'risklevel', '等级', '严重程度', '风险等级']);
  let severity: Severity | null = null;
  if (sevRaw) {
    severity = normalizeSeverity(sevRaw);
    if (severity === null) {
      issues.push({ level: 'warning', message: `无法识别的风险等级"${sevRaw}"，已置空` });
    }
  }

  const typeRaw = pick(lookup, ['type', 'questiontype', '题型']);
  const refuseRaw = pick(lookup, ['shouldrefuse', 'refuse', '应拒答', '拒答']);
  let type: QuestionType | null = typeRaw ? mapType(typeRaw) : null;
  if (typeRaw && !type) {
    issues.push({ level: 'warning', message: `无法识别的题型"${typeRaw}"，已按默认处理` });
  }
  const shouldRefuse = refuseRaw ? parseBool(refuseRaw) : type === 'SHOULD_REFUSE';
  if (!type) type = shouldRefuse ? 'SHOULD_REFUSE' : 'GENERAL';

  const item: NormalizedBenchmarkItem = {
    externalId: pick(lookup, ['id', 'externalid', 'qid', '编号']) || null,
    content,
    category,
    expectedBehavior:
      pick(lookup, ['expectedbehavior', 'expected', '预期行为', '期望行为']) || null,
    referenceAnswer: pick(lookup, ['referenceanswer', 'answer', 'reference', '参考答案']) || null,
    severity,
    tags: parseTags(pick(lookup, ['tags', 'tag', 'labels', '标签'])),
    type,
    shouldRefuse,
  };
  return { item, issues };
}

const genericJsonl: BenchmarkAdapter = {
  id: 'generic-jsonl',
  label: '通用 JSONL（自带数据集）',
  description:
    '逐行 JSON 对象，宽松字段别名（content/prompt、category、severity、tags、type、should_refuse 等）。',
  inputKind: 'jsonl',
  mapRecord: genericMap,
};

const genericCsv: BenchmarkAdapter = {
  id: 'generic-csv',
  label: '通用 CSV（自带数据集）',
  description: '带表头 CSV，宽松字段别名；severity 经统一归一化，无法识别则置空并告警。',
  inputKind: 'csv',
  mapRecord: genericMap,
};

// =====================================================================
// 公开安全基准适配器（仅解析格式，平台不内置任何数据集；数据由客户自行下载后上传）
// =====================================================================
const LICENSE_NOTE = '请遵循数据集原始许可；使用前请自行确认授权范围。';

function publicItem(
  p: Pick<NormalizedBenchmarkItem, 'externalId' | 'content' | 'category'> & {
    tags: string[];
    metadata: Record<string, unknown>;
  },
): NormalizedBenchmarkItem {
  return {
    externalId: p.externalId,
    content: p.content,
    category: p.category,
    expectedBehavior: null,
    referenceAnswer: null,
    severity: null,
    tags: dedup(p.tags),
    type: 'SHOULD_REFUSE',
    shouldRefuse: true,
    metadata: p.metadata,
  };
}

function compact(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== '' && v != null) out[k] = v;
  return out;
}

// ---- HarmBench（CSV） ----
// ContextString 非空（contextual 类行为）时，按 HarmBench 官方用法拼入题面：
// 「上下文 + 空行 + Behavior」，使被测模型看到完整任务；原始 Behavior 与 ContextString 同时保留在 metadata。
const harmBench: BenchmarkAdapter = {
  id: 'harmbench',
  label: 'HarmBench（有害行为 CSV）',
  description: '适配 HarmBench 行为 CSV，归一化为应拒答题目；ContextString 非空时拼入题面。',
  inputKind: 'csv',
  origin: 'HarmBench（Center for AI Safety / UC Berkeley 等，标准化红队评估基准）',
  typicalFiles: 'harmbench_behaviors_text_all.csv 等',
  expectedHeaders:
    'Behavior, FunctionalCategory, SemanticCategory, Tags, ContextString, BehaviorID',
  licenseNote: LICENSE_NOTE,
  usageNote:
    '用于有害请求拒答与越狱鲁棒性的横向对比。ContextString 非空的题目会把上下文拼在题面前部（上下文、空行、Behavior）。',
  requiredFields: [['Behavior']],
  mapRecord(rec): MapRecordResult {
    const l = buildLookup(rec);
    const behavior = pick(l, ['Behavior']);
    if (!behavior) return { item: null, issues: [MISSING_CONTENT] };
    const context = pick(l, ['ContextString']);
    const semantic = pick(l, ['SemanticCategory']);
    const functional = pick(l, ['FunctionalCategory']);
    const tags = parseTags(pick(l, ['Tags']));
    return {
      item: publicItem({
        externalId: pick(l, ['BehaviorID']) || null,
        content: context ? `${context}\n\n${behavior}` : behavior,
        category: semantic || null,
        tags: ['harmbench', semantic, functional, ...tags],
        metadata: compact({
          benchmark: 'harmbench',
          behaviorId: pick(l, ['BehaviorID']),
          functionalCategory: functional,
          semanticCategory: semantic,
          behavior,
          contextString: context,
        }),
      }),
      issues: [],
    };
  },
};

// ---- JailbreakBench（JBB-Behaviors，CSV） ----
const jailbreakBench: BenchmarkAdapter = {
  id: 'jailbreakbench',
  label: 'JailbreakBench（JBB-Behaviors）',
  description: '适配 JBB-Behaviors CSV，Goal 作为题面，归一化为应拒答题目。',
  inputKind: 'csv',
  origin: 'JailbreakBench（JBB-Behaviors 数据集，100 条有害行为）',
  typicalFiles: 'harmful-behaviors.csv',
  expectedHeaders: 'Goal, Target, Behavior, Category, Source',
  licenseNote: LICENSE_NOTE,
  usageNote:
    '仅适用于 harmful-behaviors 文件。benign-behaviors（无害对照）请改用「通用 CSV」并增加 should_refuse=false 列。Target 为越狱目标前缀，仅存入追溯信息，不作为参考答案。',
  requiredFields: [['Goal']],
  mapRecord(rec): MapRecordResult {
    const l = buildLookup(rec);
    const goal = pick(l, ['Goal']);
    if (!goal) return { item: null, issues: [MISSING_CONTENT] };
    const category = pick(l, ['Category']);
    const source = pick(l, ['Source']);
    const behavior = pick(l, ['Behavior']);
    return {
      item: publicItem({
        externalId: behavior || pick(l, ['Index', 'id']) || null,
        content: goal,
        category: category || null,
        tags: ['jailbreakbench', category, source],
        metadata: compact({
          benchmark: 'jailbreakbench',
          behavior,
          category,
          source,
          target: pick(l, ['Target']),
        }),
      }),
      issues: [],
    };
  },
};

// ---- StrongREJECT（CSV） ----
const strongReject: BenchmarkAdapter = {
  id: 'strongreject',
  label: 'StrongREJECT',
  description: '适配 StrongREJECT CSV，forbidden_prompt 作为题面，归一化为应拒答题目。',
  inputKind: 'csv',
  origin: 'StrongREJECT（Souly 等，越狱有效性评估基准）',
  typicalFiles: 'strongreject_dataset.csv / strongreject_small_dataset.csv',
  expectedHeaders: 'category, source, forbidden_prompt',
  licenseNote: LICENSE_NOTE,
  usageNote: '用于模型横向对比有害请求的拒答强度，覆盖多类别。',
  requiredFields: [['forbidden_prompt']],
  mapRecord(rec): MapRecordResult {
    const l = buildLookup(rec);
    const prompt = pick(l, ['forbidden_prompt']);
    if (!prompt) return { item: null, issues: [MISSING_CONTENT] };
    const category = pick(l, ['category']);
    const source = pick(l, ['source']);
    return {
      item: publicItem({
        externalId: pick(l, ['id']) || null,
        content: prompt,
        category: category || null,
        tags: ['strongreject', category, source],
        metadata: compact({ benchmark: 'strongreject', category, source }),
      }),
      issues: [],
    };
  },
};

// ---- AdvBench（CSV） ----
const advBench: BenchmarkAdapter = {
  id: 'advbench',
  label: 'AdvBench（harmful_behaviors）',
  description: '适配 AdvBench CSV，goal 作为题面，归一化为应拒答题目（无类别信息）。',
  inputKind: 'csv',
  origin: 'AdvBench（Zou 等，GCG 攻击论文配套数据集）',
  typicalFiles: 'harmful_behaviors.csv',
  expectedHeaders: 'goal, target',
  licenseNote: LICENSE_NOTE,
  usageNote:
    '经典有害请求集，题目风格单一且存在较多近似重复，适合快速冒烟；target 仅存入追溯信息。',
  requiredFields: [['goal']],
  mapRecord(rec): MapRecordResult {
    const l = buildLookup(rec);
    const goal = pick(l, ['goal']);
    if (!goal) return { item: null, issues: [MISSING_CONTENT] };
    return {
      item: publicItem({
        externalId: pick(l, ['id']) || null,
        content: goal,
        category: null,
        tags: ['advbench'],
        metadata: compact({ benchmark: 'advbench', target: pick(l, ['target']) }),
      }),
      issues: [],
    };
  },
};

// ---- XSTest（CSV）：label=safe 为「看似有害实则应当回答」，用于检测过度拒答 ----
const xsTest: BenchmarkAdapter = {
  id: 'xstest',
  label: 'XSTest（过度拒答检测）',
  description:
    '适配 XSTest CSV。label=safe 的题目标记为「应正常回答」（拒答即为过度拒答）；label=unsafe 的对照题标记为应拒答。',
  inputKind: 'csv',
  origin: 'XSTest（Röttger 等，夸大安全性/过度拒答测试集）',
  typicalFiles: 'xstest_v2_prompts.csv',
  expectedHeaders: 'id, prompt, type, label, focus, note',
  licenseNote: LICENSE_NOTE,
  usageNote: '用于检测过度拒答：safe 题看似敏感实则无害，模型应正常回答；拒答会被判为过度拒答。',
  requiredFields: [['prompt'], ['label']],
  mapRecord(rec): MapRecordResult {
    const l = buildLookup(rec);
    const prompt = pick(l, ['prompt']);
    if (!prompt) return { item: null, issues: [MISSING_CONTENT] };
    const labelRaw = pick(l, ['label']).toLowerCase();
    if (labelRaw !== 'safe' && labelRaw !== 'unsafe') {
      return {
        item: null,
        issues: [
          { level: 'error', message: `无法识别的 label"${labelRaw}"（应为 safe 或 unsafe）` },
        ],
      };
    }
    const safe = labelRaw === 'safe';
    const type = pick(l, ['type']);
    const focus = pick(l, ['focus']);
    const note = pick(l, ['note']);
    const item: NormalizedBenchmarkItem = {
      externalId: pick(l, ['id']) || null,
      content: prompt,
      category: type || null,
      expectedBehavior: safe ? '应正常回答（题目看似敏感但无害，拒答即为过度拒答）' : null,
      referenceAnswer: null,
      severity: null,
      tags: dedup([
        'xstest',
        safe ? 'xstest:safe' : 'xstest:unsafe',
        safe ? '过度拒答' : '',
        type,
        focus,
      ]),
      type: safe ? 'GENERAL' : 'SHOULD_REFUSE',
      shouldRefuse: !safe,
      metadata: compact({ benchmark: 'xstest', label: labelRaw, type, focus, note }),
    };
    return { item, issues: [] };
  },
};

// ---- BeaverTails（JSONL） ----
// is_safe 描述的是「回答」是否安全，并不等价于题面是否有害：
// 仅导入 is_safe=false（回答有害，说明题面确能诱导有害输出）的题目；is_safe=true 的行按失败行跳过并告警。
// 有害回答正文不入库，仅保留类别与标记。
function beaverCategories(raw: string): string[] {
  const s = raw.trim();
  if (!s) return [];
  try {
    const v: unknown = JSON.parse(s);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.entries(v as Record<string, unknown>)
        .filter(([, on]) => on === true)
        .map(([k]) => k);
    }
    if (Array.isArray(v)) return v.map(String);
  } catch {
    /* 非 JSON：按纯文本类别处理 */
  }
  return parseTags(s);
}

const beaverTails: BenchmarkAdapter = {
  id: 'beavertails',
  label: 'BeaverTails（问答对 JSONL）',
  description:
    '适配 BeaverTails JSONL。仅导入 is_safe=false 的行（回答有害）作为应拒答题；is_safe=true 的行会跳过。',
  inputKind: 'jsonl',
  origin: 'BeaverTails（PKU-Alignment，问答对安全标注数据集）',
  typicalFiles: '30k_train.jsonl / 330k_train.jsonl 等',
  expectedHeaders: 'prompt, response, category, is_safe',
  licenseNote: LICENSE_NOTE,
  usageNote:
    'is_safe 标注的是回答而非题面，因此只导入 is_safe=false 的行；原回答正文不会入库；同一题面会自动去重。',
  requiredFields: [['prompt'], ['is_safe']],
  mapRecord(rec): MapRecordResult {
    const l = buildLookup(rec);
    const prompt = pick(l, ['prompt']);
    if (!prompt) return { item: null, issues: [MISSING_CONTENT] };
    const safeRaw = pick(l, ['is_safe']).toLowerCase();
    if (safeRaw !== 'true' && safeRaw !== 'false') {
      return {
        item: null,
        issues: [
          { level: 'error', message: `无法识别的 is_safe"${safeRaw}"（应为 true 或 false）` },
        ],
      };
    }
    if (safeRaw === 'true') {
      return {
        item: null,
        issues: [
          { level: 'warning', message: '该行回答被标注为安全，无法据此判定题面有害，已跳过' },
        ],
      };
    }
    const cats = beaverCategories(pick(l, ['category']));
    return {
      item: publicItem({
        externalId: pick(l, ['id']) || null,
        content: prompt,
        category: cats[0] ?? null,
        tags: ['beavertails', ...cats],
        metadata: compact({ benchmark: 'beavertails', categories: cats, isSafe: false }),
      }),
      issues: [],
    };
  },
};

// ---- Do-Not-Answer（CSV） ----
const doNotAnswer: BenchmarkAdapter = {
  id: 'do-not-answer',
  label: 'Do-Not-Answer',
  description: '适配 Do-Not-Answer CSV，question 作为题面，归一化为应拒答题目，保留危害分类。',
  inputKind: 'csv',
  origin: 'Do-Not-Answer（Wang 等，LibrAI / MBZUAI，负责任回答评估数据集）',
  typicalFiles: 'Do-Not-Answer.csv',
  expectedHeaders: 'id, risk_area, types_of_harm, specific_harms, question',
  licenseNote: LICENSE_NOTE,
  usageNote:
    '多类别覆盖的拒答评估集，类别取 types_of_harm，risk_area 与 specific_harms 保留为标签。',
  requiredFields: [['question']],
  mapRecord(rec): MapRecordResult {
    const l = buildLookup(rec);
    const q = pick(l, ['question']);
    if (!q) return { item: null, issues: [MISSING_CONTENT] };
    const area = pick(l, ['risk_area']);
    const harm = pick(l, ['types_of_harm']);
    const specific = pick(l, ['specific_harms']);
    return {
      item: publicItem({
        externalId: pick(l, ['id']) || null,
        content: q,
        category: harm || area || null,
        tags: ['do-not-answer', area, harm, specific],
        metadata: compact({
          benchmark: 'do-not-answer',
          riskArea: area,
          typesOfHarm: harm,
          specificHarms: specific,
        }),
      }),
      issues: [],
    };
  },
};

export const ADAPTERS: BenchmarkAdapter[] = [
  saladBench,
  jadeDb,
  genericJsonl,
  genericCsv,
  harmBench,
  jailbreakBench,
  strongReject,
  advBench,
  xsTest,
  beaverTails,
  doNotAnswer,
];
