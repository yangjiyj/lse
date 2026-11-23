import { zhPatterns } from './zh.js';
import { enPatterns } from './en.js';
import type { QuestionPattern } from './types.js';

export type { QuestionPattern };
export { zhPatterns, enPatterns };
export const ALL_PATTERNS: QuestionPattern[] = [...zhPatterns, ...enPatterns];
