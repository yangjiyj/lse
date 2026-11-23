import { ATLAS_TECHNIQUE_IDS } from './index.js';

export type FrameworkCode = 'ATLAS' | 'OWASP_LLM' | 'OWASP_AGENTIC' | 'GBT45654_ANNEX_A';

export function isValidFrameworkEntry(framework: FrameworkCode, entryId: string): boolean {
  if (framework === 'ATLAS') return ATLAS_TECHNIQUE_IDS.has(entryId);
  if (framework === 'OWASP_LLM') return /^LLM(?:0[1-9]|10)$/.test(entryId);
  if (framework === 'OWASP_AGENTIC') return /^ASI(?:0[1-9]|10)$/.test(entryId);
  return /^A\.[1-5]$/.test(entryId);
}
