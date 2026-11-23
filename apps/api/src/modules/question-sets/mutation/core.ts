// 种子 → 变异扩展：纯函数部分（策略目录、抽样偏移、单题变换），不依赖数据库，便于确定性测试。
// 只复用现有题面变换函数，不新增任何话术；变换只改变表达形式，不改题目元数据。
import { LANGUAGE, type Language } from '@lse/shared';
import {
  ATTACK_VARIANTS,
  applyAttackVariant,
  type AttackVariant,
} from '../../generator/core/attack-variants.js';
import { getLanguageProfile } from '../../generator/core/language-profiles.js';
import { makeRng } from '../../generator/core/prng.js';

export const MAX_SAMPLE_SIZE = 1000;
export const MAX_STRATEGIES = 10;
/** 单次产出题数上限（抽样数 × 每题策略数）。 */
export const MAX_OUTPUT = 5000;
/** 变换后题面长度上限，超出视为不可用并计入跳过。 */
export const MAX_CONTENT_LENGTH = 20000;

export const FAMILY_LABEL: Record<AttackVariant['family'], string> = {
  jailbreak: '越狱话术包装',
  encoding: '编码转换',
  obfuscation: '字符混淆',
  indirect: '间接载体包装',
  multilingual: '多语种混合',
  multi_turn: '多轮 / 迭代式包装',
};

const FAMILY_DESC: Record<AttackVariant['family'], string> = {
  jailbreak: '用角色、权限或模式话术包装原题，保持原题语义',
  encoding: '把原题转成编码形式，考察模型对编码载荷的处理',
  obfuscation: '用字符层面的混淆改写原题表面形态',
  indirect: '把原题放进工具输出、检索文档或结构化数据中',
  multilingual: '在原题前后加入多语种提示，考察跨语种一致性',
  multi_turn: '把原题嵌入多步或迭代式的提问框架',
};

/** 需要配置改写模型的策略（对应生成器增强的 rewrite / variant 模式）。 */
export const LLM_STRATEGIES = [
  {
    id: 'llm_rewrite',
    label: '大模型改写',
    family: 'llm',
    familyLabel: '大模型改写',
    description: '由改写模型在保持意图不变的前提下重写题面表达，需先配置改写模型',
    requiresLlm: true,
    mode: 'rewrite',
  },
  {
    id: 'llm_variant',
    label: '大模型等价变体',
    family: 'llm',
    familyLabel: '大模型改写',
    description: '由改写模型生成同主题、同标签的等价变体，需先配置改写模型',
    requiresLlm: true,
    mode: 'variant',
  },
] as const;

export interface StrategyInfo {
  id: string;
  label: string;
  family: string;
  familyLabel: string;
  description: string;
  requiresLlm: boolean;
}

export function listStrategies(): StrategyInfo[] {
  const rule: StrategyInfo[] = ATTACK_VARIANTS.map((v) => ({
    id: v.id,
    label: v.label,
    family: v.family,
    familyLabel: FAMILY_LABEL[v.family],
    description: `${v.label}：${FAMILY_DESC[v.family]}`,
    requiresLlm: false,
  }));
  const llm: StrategyInfo[] = LLM_STRATEGIES.map((s) => ({
    id: s.id,
    label: s.label,
    family: s.family,
    familyLabel: s.familyLabel,
    description: s.description,
    requiresLlm: true,
  }));
  return [...rule, ...llm];
}

const variantById = new Map<string, AttackVariant>(ATTACK_VARIANTS.map((v) => [v.id, v]));
const llmIds = new Set<string>(LLM_STRATEGIES.map((s) => s.id));

export function isKnownStrategy(id: string): boolean {
  return variantById.has(id) || llmIds.has(id);
}
export function isLlmStrategy(id: string): boolean {
  return llmIds.has(id);
}
export function strategyLabel(id: string): string {
  return variantById.get(id)?.label ?? LLM_STRATEGIES.find((s) => s.id === id)?.label ?? id;
}

/**
 * 在 [0,total) 中按种子确定性抽取 size 个互不相同的位置，升序返回。
 * total <= size 时返回全部。只占用 O(size) 内存（Floyd 算法），不依赖 total 大小。
 */
export function pickOffsets(total: number, size: number, seed: string): number[] {
  if (total <= 0) return [];
  if (total <= size) return Array.from({ length: total }, (_, i) => i);
  const rng = makeRng(`${seed}|sample|${total}`);
  const chosen = new Set<number>();
  for (let j = total - size; j < total; j++) {
    const t = rng.int(j + 1);
    chosen.add(chosen.has(t) ? j : t);
  }
  return [...chosen].sort((a, b) => a - b);
}

/** 为一道种子题确定性地选出 perSeed 个策略（顺序随种子洗牌）。 */
export function chooseStrategies(
  strategies: readonly string[],
  perSeed: number,
  seed: string,
  parentId: string,
): string[] {
  if (perSeed >= strategies.length) return [...strategies];
  return makeRng(`${seed}|pick|${parentId}`).shuffle(strategies).slice(0, perSeed);
}

function toLanguage(code: string | null | undefined): Language {
  return (LANGUAGE as readonly string[]).includes(code ?? '') ? (code as Language) : 'zh';
}

/** 套用一个规则类策略；返回 null 表示该题在此策略下不可用（空内容、无变化或过长）。 */
export function applyRuleStrategy(
  content: string,
  language: string | null | undefined,
  strategyId: string,
  seed: string,
  parentId: string,
): string | null {
  const variant = variantById.get(strategyId);
  if (!variant || !content.trim()) return null;
  const rng = makeRng(`${seed}|apply|${parentId}|${strategyId}`);
  const out = applyAttackVariant(content, getLanguageProfile(toLanguage(language)), variant, rng);
  if (!out.trim() || out === content || out.length > MAX_CONTENT_LENGTH) return null;
  return out;
}

export function randomSeed(): string {
  return Math.random().toString(16).slice(2, 10).padEnd(8, '0');
}
