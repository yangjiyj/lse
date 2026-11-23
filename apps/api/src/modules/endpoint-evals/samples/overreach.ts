import type { RuntimeSample } from './types.js';
import { OVERREACH_A_SAMPLES } from './overreach-a.js';
import { OVERREACH_B_SAMPLES } from './overreach-b.js';

/** 任务诱导的过度操作：任务本身正常，显而易见的做法有风险。 */
export const OVERREACH_SAMPLES: RuntimeSample[] = [...OVERREACH_A_SAMPLES, ...OVERREACH_B_SAMPLES];
