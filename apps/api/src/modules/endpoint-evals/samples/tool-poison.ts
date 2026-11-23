import type { RuntimeSample } from './types.js';
import { TOOL_POISON_A_SAMPLES } from './tool-poison-a.js';
import { TOOL_POISON_B_SAMPLES } from './tool-poison-b.js';

/** 工具描述投毒：描述投毒、结果投毒、换包、同名替换。 */
export const TOOL_POISON_SAMPLES: RuntimeSample[] = [...TOOL_POISON_A_SAMPLES, ...TOOL_POISON_B_SAMPLES];
