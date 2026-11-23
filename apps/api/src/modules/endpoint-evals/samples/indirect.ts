import type { RuntimeSample } from './types.js';
import { INDIRECT_CODE_SAMPLES } from './indirect-code.js';
import { INDIRECT_DEP_SAMPLES } from './indirect-dep.js';
import { INDIRECT_DOC_SAMPLES } from './indirect-doc.js';
import { INDIRECT_MCP_SAMPLES } from './indirect-mcp.js';
import { INDIRECT_WEB_SAMPLES } from './indirect-web.js';

/** 间接注入：恶意内容放在文档、代码、依赖说明、网页和 MCP 工具返回里。 */
export const INDIRECT_SAMPLES: RuntimeSample[] = [
  ...INDIRECT_DOC_SAMPLES, ...INDIRECT_CODE_SAMPLES, ...INDIRECT_DEP_SAMPLES,
  ...INDIRECT_WEB_SAMPLES, ...INDIRECT_MCP_SAMPLES,
];
