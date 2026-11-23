import type { QuestionPattern } from '../../generator/templates/types.js';
import { STANDARD_ATTACK_PATTERNS } from '../../standard-evaluations/standard-patterns.js';
import { TC260_EXTRA_PATTERNS } from './tc260-extra-a2.js';
import { TC260_EXTRA_PATTERNS_A34 } from './tc260-extra-a34.js';

/**
 * 【旧版摸底题】本文件及 build.ts 生成的「内置合规题库 · GB/T 45654-2025 附录 A」每个小类只有 6 道模板题，
 * 共 186 题，只用于快速摸底，历史任务仍在引用，因此保留不删。
 * 不计入附录 B 的题库覆盖：附录 B 要求的固定题库见 gbt45654-bank.ts
 * （生成内容 ≥2000、应拒答 ≥500、非拒答 ≥500，带版本号与内容哈希）。
 */
/**
 * TC260 附录A 31 个小类 → 题目模板来源。
 * 优先复用 standard-patterns.ts 已有的国标样本（按其英文类别键引用），
 * 其未覆盖的小类使用 tc260-extra-*.ts 的补充模板。映射关系需人工核对。
 */
export const REUSE: Record<string, string[]> = {
  'A.1.a': ['politics'],
  'A.1.b': ['national_security', 'military', 'diplomacy'],
  'A.1.c': ['territorial_sovereignty', 'social_stability', 'public_security'],
  'A.1.d': ['terrorism_extremism'],
  'A.1.e': ['ethnicity'],
  'A.1.f': ['violence', 'pornography'],
  'A.1.g': ['misinformation', 'historical_memory', 'heroes_martyrs'],
  'A.1.h': ['drugs', 'gambling', 'crime', 'harmful_methods', 'other_illegal_harmful'],
  'A.2.a': ['ethnicity'],
  'A.2.b': ['religion'],
  'A.2.i': ['discrimination'],
  'A.3.a': ['copyright'],
  'A.3.b': ['fraud_social_engineering', 'custom_regulatory'],
  'A.4.a': ['health', 'minors', 'animal_cruelty'],
  'A.4.e': ['privacy_personal_information'],
  'A.4.f': ['privacy_personal_information'],
  'A.5.a': ['misinformation', 'education'],
  'A.5.b': ['finance', 'professional_advice'],
};

const EXTRA: Record<string, QuestionPattern[]> = {
  ...TC260_EXTRA_PATTERNS,
  ...TC260_EXTRA_PATTERNS_A34,
};

/** 返回某 TC260 小类的模板列表（已复用 + 补充）。 */
export function tc260PatternsFor(minorCode: string): QuestionPattern[] {
  const reused = (REUSE[minorCode] ?? []).flatMap((cat) =>
    STANDARD_ATTACK_PATTERNS.filter((p) => p.category === cat),
  );
  return [...reused, ...(EXTRA[minorCode] ?? [])];
}
