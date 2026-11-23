/**
 * 内置合规题库的三套分类体系（大类 → 小类）。
 *
 * - tc260：GB/T 45654-2025《网络安全技术 生成式人工智能服务安全基本要求》附录 A，5 大类 31 项。
 *   id 沿用 tc260（写入历史数据，勿改）；小类名称按 TC260-003 附录 A 原文核对（2026-11-13），
 *   与 packages/shared/src/standards/clauses-content.ts 的 ANNEX_A_ITEMS 一致。
 * - caict、energy 两套内置题库已下线（2026-11-13）：各 30 题、只覆盖诈骗一类，没有可核对的标准出处，
 *   不再列出、不再写入。energy 分类改名「能源行业自定义（非标准）」，仍可在攻击种子泛化里绑定；
 *   caict 只用于历史题目反查分类名称。
 */

export type BuiltinTaxonomyId = 'tc260' | 'caict' | 'energy' | 'safety';

export interface BuiltinMinorCategory {
  /** 稳定编码，写入题目 metadata，勿改。 */
  code: string;
  name: string;
}

export interface BuiltinMajorCategory {
  code: string;
  name: string;
  minors: BuiltinMinorCategory[];
}

export interface BuiltinTaxonomy {
  id: BuiltinTaxonomyId;
  /** 简称，用于标签页与绑定标准选项。 */
  name: string;
  /** 招标原文用语。 */
  description: string;
  majors: BuiltinMajorCategory[];
}

const m = (code: string, name: string): BuiltinMinorCategory => ({ code, name });

// 小类名称：按 GB/T 45654-2025 附录A 补录（需人工核对）。
const TC260: BuiltinTaxonomy = {
  id: 'tc260',
  name: 'GB/T 45654-2025 附录 A',
  description:
    '按 GB/T 45654-2025《网络安全技术 生成式人工智能服务安全基本要求》附录 A 的 5 大类 31 项安全风险组织',
  majors: [
    {
      code: 'A.1',
      name: 'A.1 违反社会主义核心价值观的内容',
      minors: [
        m('A.1.a', '煽动颠覆国家政权、推翻社会主义制度'),
        m('A.1.b', '危害国家安全和利益、损害国家形象'),
        m('A.1.c', '煽动分裂国家、破坏国家统一和社会稳定'),
        m('A.1.d', '宣扬恐怖主义、极端主义'),
        m('A.1.e', '宣扬民族仇恨'),
        m('A.1.f', '宣扬暴力、淫秽色情'),
        m('A.1.g', '传播虚假有害信息'),
        m('A.1.h', '其他法律、行政法规禁止的内容'),
      ],
    },
    {
      code: 'A.2',
      name: 'A.2 歧视性内容',
      minors: [
        m('A.2.a', '民族歧视内容'),
        m('A.2.b', '信仰歧视内容'),
        m('A.2.c', '国别歧视内容'),
        m('A.2.d', '地域歧视内容'),
        m('A.2.e', '性别歧视内容'),
        m('A.2.f', '年龄歧视内容'),
        m('A.2.g', '职业歧视内容'),
        m('A.2.h', '健康歧视内容'),
        m('A.2.i', '其他方面歧视内容'),
      ],
    },
    {
      code: 'A.3',
      name: 'A.3 商业违法违规',
      minors: [
        m('A.3.a', '侵犯他人知识产权'),
        m('A.3.b', '违反商业道德'),
        m('A.3.c', '泄露他人商业秘密'),
        m('A.3.d', '利用算法、数据、平台等优势，实施垄断和不正当竞争行为'),
        m('A.3.e', '其他商业违法违规行为'),
      ],
    },
    {
      code: 'A.4',
      name: 'A.4 侵犯他人合法权益',
      minors: [
        m('A.4.a', '危害他人身心健康'),
        m('A.4.b', '侵害他人肖像权'),
        m('A.4.c', '侵害他人名誉权'),
        m('A.4.d', '侵害他人荣誉权'),
        m('A.4.e', '侵害他人隐私权'),
        m('A.4.f', '侵害他人个人信息权益'),
        m('A.4.g', '侵犯他人其他合法权益'),
      ],
    },
    {
      code: 'A.5',
      name: 'A.5 无法满足特定服务类型的安全需求',
      minors: [
        m('A.5.a', '内容不准确，严重不符合科学常识或主流认知'),
        m('A.5.b', '内容不可靠，虽然不包含严重错误的内容，但无法对使用者形成帮助'),
      ],
    },
  ],
};

const CAICT: BuiltinTaxonomy = {
  id: 'caict',
  name: '中国信通院',
  description:
    '基于中国信息通信研究院标准的违法违规内容检测分类体系，覆盖涉黄、涉暴、涉赌、危险化学品、诈骗五大违法违规类型',
  majors: [
    {
      code: 'CAICT',
      name: '违法违规内容',
      minors: [
        m('CAICT.porn', '涉黄'),
        m('CAICT.violence', '涉暴'),
        m('CAICT.gambling', '涉赌'),
        m('CAICT.hazchem', '危险化学品'),
        m('CAICT.fraud', '诈骗'),
      ],
    },
  ],
};

const ENERGY: BuiltinTaxonomy = {
  id: 'energy',
  name: '能源行业自定义（非标准）',
  description:
    '能源行业场景的自定义分类（非国家或行业标准），覆盖资金骗取、证据灭失、舆情操控、身份冒用等类型，仅用于攻击种子泛化时标注场景',
  majors: [
    {
      code: 'ENERGY',
      name: '能源行业违法违规',
      minors: [
        m('ENERGY.fund_fraud', '资金骗取'),
        m('ENERGY.evidence_destruction', '证据灭失'),
        m('ENERGY.opinion_manipulation', '舆情操控'),
        m('ENERGY.impersonation', '身份冒用'),
        m('ENERGY.dispatch_forgery', '调控指令伪造'),
        m('ENERGY.pipeline_coordinates', '管道坐标泄露'),
      ],
    },
  ],
};

// 中文通用安全场景：随平台内置的开源评测数据集 thu-coai/Safety-Prompts（Apache-2.0），
// 分类名称沿用数据集论文的中文命名（7 类典型安全场景 + 6 类指令攻击）。
const SAFETY: BuiltinTaxonomy = {
  id: 'safety',
  name: '中文通用安全场景',
  description:
    '基于开源中文大模型安全评测数据集 Safety-Prompts（清华大学 CoAI，Apache-2.0）的 7 类典型安全场景与 6 类指令攻击场景，近 10 万道中文测评题目',
  majors: [
    {
      code: 'SAFETY.typical',
      name: '典型安全场景',
      minors: [
        m('SAFETY.insult', '脏话侮辱'),
        m('SAFETY.discrimination', '偏见歧视'),
        m('SAFETY.crime', '违法犯罪'),
        m('SAFETY.physical_harm', '身体伤害'),
        m('SAFETY.mental_health', '心理健康'),
        m('SAFETY.privacy_property', '财产隐私'),
        m('SAFETY.ethics', '道德伦理'),
      ],
    },
    {
      code: 'SAFETY.attack',
      name: '指令攻击场景',
      minors: [
        m('SAFETY.goal_hijacking', '目标劫持'),
        m('SAFETY.prompt_leaking', 'Prompt泄漏'),
        m('SAFETY.role_play', '赋予角色后发指令'),
        m('SAFETY.unsafe_topic', '不安全的指令主题'),
        m('SAFETY.unsafe_opinion', '带有不安全观点的询问'),
        m('SAFETY.reverse_exposure', '反面诱导'),
      ],
    },
  ],
};

export const BUILTIN_TAXONOMIES: readonly BuiltinTaxonomy[] = [TC260, SAFETY];

/** 已下线的体系：不列出、不写入，只用于历史题目反查分类名称。 */
export const RETIRED_BUILTIN_TAXONOMIES: readonly BuiltinTaxonomy[] = [CAICT, ENERGY];

export const BUILTIN_TAXONOMY_IDS: readonly BuiltinTaxonomyId[] = ['tc260', 'safety'];

/**
 * 攻击种子泛化可绑定的分类：国标附录 A、能源行业自定义（明确标为非标准）、通用安全场景。
 * 信通院分类没有可核对的出处，不可绑定。
 */
export const BINDABLE_TAXONOMIES: readonly BuiltinTaxonomy[] = [TC260, ENERGY, SAFETY];
export const BINDABLE_TAXONOMY_IDS: readonly BuiltinTaxonomyId[] = ['tc260', 'energy', 'safety'];

/** 合规分类体系（由平台模板/自编题目构成）；safety 为随附的开源数据集题库。 */
/** 单次评测的抽样上限（题数），前后端共用。 */
export const MAX_SAMPLE_SIZE = 20000;

export const COMPLIANCE_TAXONOMY_IDS: readonly BuiltinTaxonomyId[] = ['tc260'];

/** 已下线内置题库的 source：列表、选题一律排除；历史任务仍可按 id 查看。 */
export const RETIRED_BUILTIN_SET_SOURCES: readonly string[] = [
  'builtin:compliance:caict',
  'builtin:compliance:energy',
];

/** 各体系对应内置题库的 source 幂等键。 */
export function builtinSetSource(id: BuiltinTaxonomyId): string {
  return id === 'safety' ? 'builtin:dataset:safety-prompts' : `builtin:compliance:${id}`;
}

/** 按 id 取分类定义（含已下线、仅可绑定的分类，供历史数据与攻击种子绑定反查）。 */
export function getBuiltinTaxonomy(id: string): BuiltinTaxonomy | undefined {
  return [TC260, CAICT, ENERGY, SAFETY].find((t) => t.id === id);
}

export interface BuiltinCategoryRef {
  taxonomy: BuiltinTaxonomyId;
  majorCode: string;
  major: string;
  minorCode: string;
  minor: string;
}

/** 按小类编码反查所属体系、大类与中文名。 */
export function findBuiltinCategory(minorCode: string): BuiltinCategoryRef | undefined {
  for (const t of [...BUILTIN_TAXONOMIES, ...RETIRED_BUILTIN_TAXONOMIES]) {
    for (const major of t.majors) {
      const minor = major.minors.find((x) => x.code === minorCode);
      if (minor) {
        return {
          taxonomy: t.id,
          majorCode: major.code,
          major: major.name,
          minorCode: minor.code,
          minor: minor.name,
        };
      }
    }
  }
  return undefined;
}

/** 某体系下全部小类（按定义顺序）。 */
export function listBuiltinMinors(id: BuiltinTaxonomyId): BuiltinCategoryRef[] {
  const t = getBuiltinTaxonomy(id);
  if (!t) return [];
  return t.majors.flatMap((major) =>
    major.minors.map((minor) => ({
      taxonomy: t.id,
      majorCode: major.code,
      major: major.name,
      minorCode: minor.code,
      minor: minor.name,
    })),
  );
}
