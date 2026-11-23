import type { Language } from '@lse/shared';
import type { GeneratedQuestion } from '../core/types.js';

export const ENHANCE_MODES = ['rewrite', 'induce', 'variant'] as const;
export type EnhanceMode = (typeof ENHANCE_MODES)[number];

export const ENHANCE_INTENSITIES = [1, 2, 3] as const;
export type EnhanceIntensity = (typeof ENHANCE_INTENSITIES)[number];

export interface EnhanceSpec {
  mode: EnhanceMode;
  intensity: EnhanceIntensity;
  language?: Language;
  sampleLimit?: number;
}

export interface EnhanceStats {
  configured: boolean;
  requested: number;
  applied: number;
  failed: number;
  skippedReason: 'not_requested' | 'not_configured' | null;
}

export interface EnhancedSample {
  before: string;
  after: string;
}

export interface EnhanceResult {
  questions: GeneratedQuestion[];
  stats: EnhanceStats;
  samples: EnhancedSample[];
}
