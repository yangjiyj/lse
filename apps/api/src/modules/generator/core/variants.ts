import type { Language } from '@lse/shared';
import { getLanguageProfile } from './language-profiles.js';
import type { Rng } from './prng.js';

export function applyVariant(
  content: string,
  language: Language,
  strength: 0 | 1 | 2,
  rng: Rng,
): string {
  if (strength === 0) return content;
  const profile = getLanguageProfile(language);
  const prefix = rng.pick(['', profile.promptPrefix]);
  let out = prefix + content;
  if (strength === 2) out = out + rng.pick(['', ` ${profile.safetySuffix}`]);
  return out;
}
