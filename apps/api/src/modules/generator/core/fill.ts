import type { Rng } from './prng.js';
import type { QuestionPattern } from '../templates/types.js';

const SLOT_RE = /\{(\w+)\}/g;

export function slotNames(template: string): string[] {
  const names = new Set<string>();
  SLOT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SLOT_RE.exec(template)) !== null) names.add(m[1]!); // 正则匹配成功时捕获组 1 必存在
  return [...names];
}

export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(SLOT_RE, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name]! : whole,
  );
}

export function patternCapacity(pattern: QuestionPattern): number {
  const names = slotNames(pattern.template);
  if (names.length === 0) return 1;
  return names.reduce((acc, n) => acc * Math.max(1, (pattern.slots[n] ?? []).length), 1);
}

export function sampleFilled(
  pattern: QuestionPattern,
  rng: Rng,
): { content: string; values: Record<string, string>; key: string } {
  const names = slotNames(pattern.template);
  const chosen: Record<string, string> = {};
  for (const n of names) {
    const words = pattern.slots[n] ?? [];
    chosen[n] = words.length > 0 ? rng.pick(words) : `{${n}}`;
  }
  const content = fillTemplate(pattern.template, chosen);
  const key = `${pattern.id}|${names.map((n) => chosen[n]).join('|')}`;
  return { content, values: chosen, key };
}
