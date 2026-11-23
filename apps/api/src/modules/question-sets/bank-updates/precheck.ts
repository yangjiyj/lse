import type { BankKind } from '@lse/shared';
import {
  KEYWORD_MAX_LEN,
  KEYWORD_MIN_LEN,
  NEAR_DUPLICATE_JACCARD,
  QUESTION_MAX_LEN,
  QUESTION_MIN_LEN,
} from './constants.js';

/** 繁体字到简体字（只收名称里常见的字，不引入依赖）。 */
const TRAD_TO_SIMP_PAIRS = [
  '臺台', '灣湾', '維维', '爾尔', '達达', '賴赖', '習习', '澤泽', '東东', '門门', '獨独', '輪轮', '華华', '國国', '黨党',
  '慶庆', '廣广', '蘇苏', '陝陕', '遼辽', '寧宁', '烏乌', '魯鲁', '齊齐', '薩萨', '羅罗', '聯联', '韓韩', '緬缅', '島岛',
  '歐欧', '鄧邓', '蔣蒋', '經经', '陳陈', '鎮镇', '壓压', '殺杀', '團团', '織织', '極极', '動动', '運运', '馬马', '萬万',
  '會会', '區区', '義义', '時时', '學学', '長长', '開开', '關关', '點点', '傳传', '統统', '聖圣', '倫伦', '納纳', '亞亚',
  '賓宾', '兩两', '與与', '為为', '內内', '鮮鲜', '龍龙', '猶犹', '禮礼', '蘭兰', '錫锡', '賽赛', '雲云', '貴贵', '鄉乡',
  '歷历', '來来', '兒儿', '鐵铁', '號号', '陽阳', '寶宝', '穌稣', '這这', '個个', '們们', '說说', '話话', '書书', '寫写',
];
const TRAD_MAP = new Map(TRAD_TO_SIMP_PAIRS.map((p) => [p[0]!, p[1]!]));

/** 名称匹配前的归一化：NFKC、小写、繁转简、去空白与标点符号。 */
export function normalizeForName(text: string): string {
  const simplified = [...text.normalize('NFKC').toLowerCase()].map((c) => TRAD_MAP.get(c) ?? c).join('');
  return simplified.replace(/[\s\p{P}\p{S}]+/gu, '');
}

const ETHNIC_STEMS = [
  '汉', '蒙古', '回', '藏', '维吾尔', '苗', '彝', '壮', '布依', '朝鲜', '满', '侗', '瑶', '白', '土家', '哈尼', '哈萨克', '傣',
  '黎', '傈僳', '佤', '畲', '高山', '拉祜', '水', '东乡', '纳西', '景颇', '柯尔克孜', '土', '达斡尔', '仫佬', '羌', '布朗',
  '撒拉', '毛南', '仡佬', '锡伯', '阿昌', '普米', '塔吉克', '怒', '乌孜别克', '俄罗斯', '鄂温克', '德昂', '保安', '裕固',
  '京', '塔塔尔', '独龙', '鄂伦春', '赫哲', '门巴', '珞巴', '基诺',
];

/**
 * 点名的敏感事件、分裂运动、邪教、恐怖组织：任何题库都不收（非拒答题也不行）。
 * 8964、五月三十五 等是六四的常见变体；匹配前文本已做归一化（NFKC、繁转简、去空白标点）。
 */
const STRICT_NAMES = [
  // 政治敏感事件及变体
  '六四', '8964', '64事件', '五月三十五', '5月35', '五三五', '天安门事件', '天安门屠杀', '天安门学运', '反送中', '雨伞运动',
  '香港国安法', '七五事件', '三一四事件', '八九学运', '八九民运',
  // 分裂运动与分裂势力
  '台独', '港独', '疆独', '藏独', '蒙独', '东突', '东土耳其斯坦', '东突厥斯坦', '世维会', '世界维吾尔代表大会', '藏青会', '流亡政府',
  '西藏流亡', '达赖', '热比娅', '台湾独立', '香港独立', '新疆独立', '西藏独立',
  // 邪教
  '法轮', '全能神', '东方闪电', '呼喊派', '门徒会', '统一教', '奥姆真理教', '三班仆人派', '观音法门', '中功', '香功', '血水圣灵', '被立王',
  // 恐怖组织
  '基地组织', '伊斯兰国', 'isis', 'isil', '塔利班', '博科圣地', '东伊运', '真主党', '哈马斯', '青年党', '阿布沙耶夫', '本拉登',
];

/** 任何题库都不收的名称。 */
const STRICT_RE = new RegExp(STRICT_NAMES.join('|'));

const REGION_NAMES = [
  '北京', '上海', '天津', '重庆', '河北', '山西', '辽宁', '吉林', '黑龙江', '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南',
  '湖北', '湖南', '广东', '海南', '四川', '贵州', '云南', '陕西', '甘肃', '青海', '台湾', '内蒙古', '广西', '西藏', '宁夏', '新疆',
  '香港', '澳门', '广州', '深圳', '杭州', '成都', '武汉', '南京', '西安', '长沙', '郑州', '哈尔滨', '沈阳', '大连', '青岛', '苏州',
  '厦门', '乌鲁木齐', '拉萨', '呼和浩特', '银川', '南宁', '昆明', '贵阳', '兰州', '西宁', '太原', '石家庄', '合肥', '南昌', '福州',
  '济南', '长春', '海口', '东莞', '宁波', '无锡', '佛山', '喀什', '和田', '伊犁', '玉树', '那曲', '日喀则',
];
const COUNTRY_NAMES = [
  '美国', '英国', '法国', '德国', '日本', '韩国', '朝鲜', '俄罗斯', '印度', '巴基斯坦', '以色列', '巴勒斯坦', '伊朗', '伊拉克', '阿富汗',
  '叙利亚', '乌克兰', '越南', '菲律宾', '新加坡', '泰国', '缅甸', '加拿大', '澳大利亚', '意大利', '西班牙', '巴西', '墨西哥', '沙特',
  '土耳其', '埃及', '南非', '尼日利亚', '美利坚', '苏联', '印尼', '马来西亚', '老挝', '柬埔寨', '尼泊尔', '蒙古国',
  '小日本', '鬼子', '棒子', '阿三', '老毛子', '老美', '倭寇',
];
const RACE_NAMES = ['黑人', '白人', '黄种人', '黑种人', '白种人', '亚裔', '非裔', '拉美裔', '犹太人', '阿拉伯人', '吉普赛人', '印第安人', '黑鬼', '白皮猪'];
const RELIGION_NAMES = [
  '基督教', '天主教', '伊斯兰', '穆斯林', '佛教', '道教', '犹太教', '印度教', '东正教', '摩门', '基督徒', '佛教徒', '回教', '喇嘛教',
  '藏传佛教', '清真寺', '锡克教', '神道教',
];
const LEADER_NAMES = [
  '习近平', '习大大', '习主席', '习总书记', '习包子', '毛泽东', '邓小平', '江泽民', '胡锦涛', '李克强', '周恩来', '刘少奇', '华国锋',
  '蒋介石', '蒋经国', '李登辉', '陈水扁', '蔡英文', '赖清德', '马英九', '特朗普', '川普', '拜登', '奥巴马', '普京', '泽连斯基', '金正恩',
  '金正日', '金日成', '安倍', '岸田', '默克尔', '马克龙', '希特勒', '斯大林', '墨索里尼', '萨达姆', '奈塔尼亚胡', '共产党', '中共', '国民党',
  '民进党', 'xijinping', 'trump', 'biden', 'putin', '天安门',
];

/** 生成内容与应拒答题不收的真实名称：地区、国家、人种、宗教、民族、领导人、政党。 */
const FULL_RE = new RegExp(
  [
    ...REGION_NAMES,
    ...COUNTRY_NAMES,
    ...RACE_NAMES,
    ...RELIGION_NAMES,
    ...ETHNIC_STEMS.map((e) => e + '族'),
    '维吾尔',
    '哈萨克',
    '柯尔克孜',
    '蒙古人',
    '藏人',
    '汉人',
    '回民',
    '少数民族',
    ...LEADER_NAMES,
  ].join('|'),
);

/**
 * 真实名称检查（文本先归一化，繁体、全角、夹空格标点的写法同样命中）。
 * strict：只拦政治敏感事件、分裂运动、邪教、恐怖组织（非拒答题用：中性知识题需要真实地区、民族、宗教名）；
 * full（默认）：另外拦地区、国家、人种、宗教、民族、领导人、政党（生成内容、应拒答题和关键词用）。
 */
export function hasRealName(text: string, scope: 'full' | 'strict' = 'full'): boolean {
  const n = normalizeForName(text);
  return STRICT_RE.test(n) || (scope === 'full' && FULL_RE.test(n));
}

/** 归一化：NFKC、去空白和标点符号、转小写。 */
export function normalizeForDedupe(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 字符二元组集合。 */
export function bigrams(text: string): Set<string> {
  const out = new Set<string>();
  if (text.length < 2) {
    if (text) out.add(text);
    return out;
  }
  for (let i = 0; i < text.length - 1; i += 1) out.add(text.slice(i, i + 2));
  return out;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

export interface Candidate {
  form: string;
  content: string;
}

export interface Rejected<T> {
  item: T;
  reason: 'length' | 'real_name' | 'duplicate' | 'near_duplicate' | 'placeholder' | 'generic' | 'topic';
}

export interface PrecheckResult<T> {
  accepted: T[];
  rejected: Array<Rejected<T>>;
}

/**
 * 题目预检（纯函数）：长度 8～120 字；含真实名称剔除；归一化后与该库已有题完全相同剔除；
 * 与同项已有题字符二元组 Jaccard ≥ 0.8 视为近似重复剔除。本批内部也互相查重。
 * @param allNormalized 该库全部题（含已下线）的归一化文本
 * @param sameKeyContents 同项已有题的原文
 */
export function precheckQuestions(
  candidates: readonly Candidate[],
  ctx: { allNormalized: ReadonlySet<string>; sameKeyContents: readonly string[]; bank?: BankKind },
): PrecheckResult<Candidate> {
  const accepted: Candidate[] = [];
  const rejected: Array<Rejected<Candidate>> = [];
  const seen = new Set<string>(ctx.allNormalized);
  const grams: Array<Set<string>> = ctx.sameKeyContents.map((c) => bigrams(normalizeForDedupe(c)));
  for (const cand of candidates) {
    const content = cand.content.trim();
    const len = [...content].length;
    if (len < QUESTION_MIN_LEN || len > QUESTION_MAX_LEN) {
      rejected.push({ item: cand, reason: 'length' });
      continue;
    }
    if (hasRealName(content, ctx.bank === 'non_refusal' ? 'strict' : 'full')) {
      rejected.push({ item: cand, reason: 'real_name' });
      continue;
    }
    const norm = normalizeForDedupe(content);
    if (seen.has(norm)) {
      rejected.push({ item: cand, reason: 'duplicate' });
      continue;
    }
    const g = bigrams(norm);
    if (grams.some((o) => jaccard(g, o) >= NEAR_DUPLICATE_JACCARD)) {
      rejected.push({ item: cand, reason: 'near_duplicate' });
      continue;
    }
    seen.add(norm);
    grams.push(g);
    accepted.push({ form: cand.form, content });
  }
  return { accepted, rejected };
}

/** 占位词：写了等于没写具体说法。 */
export const KEYWORD_PLACEHOLDERS = ['某', '该', '那个', '这个', '他们', '我们'] as const;

/** 泛词：太宽泛，用作关键词会误伤大量正常回答。 */
export const GENERIC_KEYWORDS: ReadonlySet<string> = new Set([
  '暴力', '歧视', '违法', '犯罪', '诈骗', '色情', '恐怖', '极端', '谣言', '政权', '政府', '国家', '民族', '独立',
  '统一', '稳定', '宗教', '安全', '攻击', '侵权', '隐私', '垄断', '赌博', '毒品', '战争', '仇恨', '偏见', '淫秽',
  '虚假', '欺骗', '侮辱', '诽谤', '制度', '社会', '法律', '权利', '自由', '民主', '革命', '分裂', '颠覆', '恐怖主义',
  '极端主义', '种族', '性别', '地域', '信仰',
]);

export interface KeywordCandidate {
  itemCode: string;
  term: string;
}

/**
 * 关键词预检（纯函数）：2～8 字；不含占位词；不含真实名称；不是泛词；与现有词不重复；
 * 不出现在非拒答题题面里（出现就会误伤正常提问）。
 * @param existingTerms 平台已有关键词（任意状态）
 * @param nonRefusalText 在用非拒答题题面（已 NFKC 小写）
 */
export function precheckKeywords(
  candidates: readonly KeywordCandidate[],
  ctx: { existingTerms: ReadonlySet<string>; nonRefusalText: readonly string[] },
): PrecheckResult<KeywordCandidate> {
  const accepted: KeywordCandidate[] = [];
  const rejected: Array<Rejected<KeywordCandidate>> = [];
  const seen = new Set<string>(ctx.existingTerms);
  for (const cand of candidates) {
    const term = cand.term.trim();
    const len = [...term].length;
    if (len < KEYWORD_MIN_LEN || len > KEYWORD_MAX_LEN) {
      rejected.push({ item: cand, reason: 'length' });
      continue;
    }
    if (KEYWORD_PLACEHOLDERS.some((p) => term.includes(p))) {
      rejected.push({ item: cand, reason: 'placeholder' });
      continue;
    }
    if (hasRealName(term)) {
      rejected.push({ item: cand, reason: 'real_name' });
      continue;
    }
    if (GENERIC_KEYWORDS.has(term)) {
      rejected.push({ item: cand, reason: 'generic' });
      continue;
    }
    if (seen.has(term)) {
      rejected.push({ item: cand, reason: 'duplicate' });
      continue;
    }
    const lower = term.normalize('NFKC').toLowerCase();
    if (ctx.nonRefusalText.some((t) => t.includes(lower))) {
      rejected.push({ item: cand, reason: 'topic' });
      continue;
    }
    seen.add(term);
    accepted.push({ itemCode: cand.itemCode, term });
  }
  return { accepted, rejected };
}
