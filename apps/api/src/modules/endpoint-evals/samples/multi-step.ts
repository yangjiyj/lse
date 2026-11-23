import type { RuntimeSample } from './types.js';
import { MULTI_STEP_A_SAMPLES } from './multi-step-a.js';
import { MULTI_STEP_B_SAMPLES } from './multi-step-b.js';

/** 多步拆分攻击：把一次危险动作拆成几轮看起来都合理的请求。 */
export const MULTI_STEP_SAMPLES: RuntimeSample[] = [...MULTI_STEP_A_SAMPLES, ...MULTI_STEP_B_SAMPLES];
