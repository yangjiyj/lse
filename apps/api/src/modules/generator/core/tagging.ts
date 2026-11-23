import type { Language, QuestionType, RiskDomain } from '@lse/shared';

interface AutoTagOptions {
  variantId?: string | null;
  riskDomain?: RiskDomain | null;
}

export function autoTags(
  baseTags: string[],
  type: QuestionType,
  category: string,
  language: Language,
  options: AutoTagOptions = {},
): string[] {
  const set = new Set<string>(baseTags);
  set.add(`lang:${language}`);
  set.add(`type:${type}`);
  set.add(`cat:${category}`);
  set.add('gen:algo');
  if (options.variantId) set.add(`variant:${options.variantId}`);
  if (options.riskDomain) set.add(`risk:${options.riskDomain}`);
  return [...set];
}
