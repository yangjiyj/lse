import { RISK_DOMAIN_LABELS, type Language, type RiskDomain } from '@lse/shared';
import type { QuestionPattern } from '../templates/types.js';
import type {
  GenerateSpec,
  GeneratedQuestion,
  GenerateOutcome,
  GenerateVariantStrength,
} from './types.js';
import { makeRng } from './prng.js';
import { sampleFilled, fillTemplate, patternCapacity } from './fill.js';
import { applyVariant } from './variants.js';
import { autoTags } from './tagging.js';
import { specSignature } from './signature.js';
import {
  ATTACK_VARIANTS,
  applyAttackVariant,
  attackVariantLabel,
  inferRiskDomain,
} from './attack-variants.js';
import { LANGUAGE_PROFILES, getLanguageProfile, languageLabel } from './language-profiles.js';

const VARIANT_FACTOR: Record<0 | 1 | 2, number> = { 0: 1, 1: 5, 2: 20 };
const EMPTY_DIVERSITY = { languages: [], variants: [], riskDomains: [] };

function isAutoLanguage(spec: GenerateSpec): boolean {
  return !spec.language || spec.language === 'auto';
}

export function selectPatterns(all: QuestionPattern[], spec: GenerateSpec): QuestionPattern[] {
  const cats = spec.categories && spec.categories.length > 0 ? new Set(spec.categories) : null;
  const types = new Set(spec.types);
  const autoLanguage = isAutoLanguage(spec);
  return all.filter(
    (p) =>
      (autoLanguage || p.language === spec.language) &&
      types.has(p.type) &&
      (!cats || cats.has(p.category)),
  );
}

export function capacityCeiling(
  patterns: QuestionPattern[],
  variantStrength: GenerateVariantStrength,
  languageCount = 1,
): number {
  const base = patterns.reduce((acc, p) => acc + patternCapacity(p), 0);
  const variantFactor =
    variantStrength === 'auto' ? ATTACK_VARIANTS.length : VARIANT_FACTOR[variantStrength];
  return base * Math.max(1, languageCount) * variantFactor;
}

function normalizeContent(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function chartFromCounts<T extends string>(values: readonly T[], labelFor: (key: T) => string) {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].map(([key, count]) => ({ key, label: labelFor(key), count }));
}

function buildDiversity(questions: readonly GeneratedQuestion[]): GenerateOutcome['diversity'] {
  return {
    languages: chartFromCounts(
      questions.map((q) => q.language),
      (key) => languageLabel(key),
    ),
    variants: chartFromCounts(
      questions.map((q) => q.variantId),
      attackVariantLabel,
    ),
    riskDomains: chartFromCounts(
      questions.map((q) => q.riskDomain),
      (key) => RISK_DOMAIN_LABELS[key as RiskDomain] ?? key,
    ),
  };
}

export function generate(all: QuestionPattern[], spec: GenerateSpec): GenerateOutcome {
  const autoLanguage = isAutoLanguage(spec);
  const variantStrength = spec.variantStrength ?? (autoLanguage ? 'auto' : 0);
  const autoVariant = variantStrength === 'auto';
  const legacyVariantStrength: 0 | 1 | 2 = variantStrength === 'auto' ? 0 : variantStrength;
  const dedupe = spec.dedupe ?? true;
  const patterns = selectPatterns(all, spec);
  const ceiling = capacityCeiling(
    patterns,
    variantStrength,
    autoLanguage ? LANGUAGE_PROFILES.length : 1,
  );
  const target = Math.min(spec.count, ceiling);
  const sig = specSignature(spec);
  const rng = makeRng(spec.seed ?? sig);
  const languageCycle = rng.shuffle(LANGUAGE_PROFILES);
  const variantCycle = rng.shuffle(ATTACK_VARIANTS);

  const questions: GeneratedQuestion[] = [];
  if (patterns.length === 0 || target <= 0) {
    return {
      requested: spec.count,
      produced: 0,
      capacityCeiling: ceiling,
      questions,
      diversity: EMPTY_DIVERSITY,
    };
  }

  const seen = new Set<string>();
  const maxGuard = target * 50 + 1000;
  let attempts = 0;

  while (questions.length < target && attempts < maxGuard) {
    attempts++;
    const pattern = rng.pick(patterns);
    const { content: filled, values } = sampleFilled(pattern, rng);
    const profile = autoLanguage
      ? languageCycle[questions.length % languageCycle.length]!
      : getLanguageProfile((spec.language ?? pattern.language) as Language);
    const variant = autoVariant ? variantCycle[questions.length % variantCycle.length]! : null;
    const content = variant
      ? applyAttackVariant(filled, profile, variant, rng)
      : applyVariant(filled, profile.code, legacyVariantStrength, rng);
    if (dedupe) {
      const k = normalizeContent(content);
      if (seen.has(k)) continue;
      seen.add(k);
    }
    const riskDomain = inferRiskDomain(pattern, variant);
    const variantId = variant?.id ?? `legacy_${legacyVariantStrength}`;
    questions.push({
      content,
      type: pattern.type,
      category: pattern.category,
      language: profile.code,
      severity: pattern.severity,
      shouldRefuse: pattern.shouldRefuse,
      expectedBehavior: pattern.expectedBehavior
        ? fillTemplate(pattern.expectedBehavior, values)
        : null,
      referenceAnswer: pattern.referenceAnswer
        ? fillTemplate(pattern.referenceAnswer, values)
        : null,
      tags: autoTags(pattern.tags, pattern.type, pattern.category, profile.code, {
        variantId,
        riskDomain,
      }),
      externalId: `${sig}-${questions.length}`,
      variantId,
      riskDomain,
    });
  }

  return {
    requested: spec.count,
    produced: questions.length,
    capacityCeiling: ceiling,
    questions,
    diversity: buildDiversity(questions),
  };
}
