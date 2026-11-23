import type { RuntimeSample } from './types.js';
import { MEMORY_CONFIG_A_SAMPLES } from './memory-config-a.js';
import { MEMORY_CONFIG_B_SAMPLES } from './memory-config-b.js';

/** 记忆和配置文件投毒：指令写进会被自动加载或信任的配置文件。 */
export const MEMORY_CONFIG_SAMPLES: RuntimeSample[] = [...MEMORY_CONFIG_A_SAMPLES, ...MEMORY_CONFIG_B_SAMPLES];
