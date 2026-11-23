import type { GenerateSpec } from './types.js';

function fnv1a(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function specSignature(spec: GenerateSpec): string {
  const normalized = {
    types: [...spec.types].sort(),
    categories: spec.categories ? [...spec.categories].sort() : [],
    language: spec.language ?? 'auto',
    count: spec.count,
    variantStrength: spec.variantStrength ?? (spec.language ? 0 : 'auto'),
    seed: spec.seed ?? '',
    dedupe: spec.dedupe ?? true,
  };
  return 'gen' + fnv1a(JSON.stringify(normalized)).toString(36);
}
