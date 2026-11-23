import type { RuntimeSample } from './types.js';
import { DIRECT_A_SAMPLES } from './direct-a.js';
import { DIRECT_B_SAMPLES } from './direct-b.js';

/** 直接请求：任务描述里夹带越权要求。 */
export const DIRECT_SAMPLES: RuntimeSample[] = [...DIRECT_A_SAMPLES, ...DIRECT_B_SAMPLES];
