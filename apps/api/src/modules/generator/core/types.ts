import type { Language, QuestionType, RiskDomain, Severity } from '@lse/shared';

export type GenerateLanguage = Language | 'auto';
export type GenerateVariantStrength = 0 | 1 | 2 | 'auto';

export interface GenerateSpec {
  types: QuestionType[];
  categories?: string[];
  language?: GenerateLanguage;
  count: number;
  variantStrength?: GenerateVariantStrength;
  seed?: string;
  dedupe?: boolean;
}

export interface GeneratedQuestion {
  content: string;
  type: QuestionType;
  category: string;
  language: Language;
  severity: Severity;
  shouldRefuse: boolean;
  expectedBehavior: string | null;
  referenceAnswer: string | null;
  tags: string[];
  externalId: string;
  variantId: string;
  riskDomain: RiskDomain;
}

export interface DiversityDatum {
  key: string;
  label: string;
  count: number;
}

export interface GenerateDiversitySummary {
  languages: DiversityDatum[];
  variants: DiversityDatum[];
  riskDomains: DiversityDatum[];
}

export interface GenerateOutcome {
  requested: number;
  produced: number;
  capacityCeiling: number;
  questions: GeneratedQuestion[];
  diversity: GenerateDiversitySummary;
}
