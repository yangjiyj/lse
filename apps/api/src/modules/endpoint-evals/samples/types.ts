/**
 * 样本库用到的共享类型，只做 re-export，不重定义。
 * 契约见 CONTRACT.md 第 9 节。
 */
export {
  RUNTIME_ARMS,
  RUNTIME_AVG_SCENARIO_SECONDS,
  RUNTIME_CHANNELS,
  RUNTIME_HARMS,
  RUNTIME_HOME_DECOYS,
  RUNTIME_MAX_SCENARIOS,
  RUNTIME_TEMPLATES,
  RUNTIME_VECTORS,
  RUNTIME_WORKSPACE_DECOYS,
} from '../../../../../../packages/shared/src/runtime-eval.js';
export type {
  RuntimeArm,
  RuntimeChannel,
  RuntimeDanger,
  RuntimeExpect,
  RuntimeHarm,
  RuntimeMcpServer,
  RuntimeMcpSpec,
  RuntimeMcpTool,
  RuntimeSample,
  RuntimeScenarioFields,
  RuntimeTemplate,
  RuntimeTier,
  RuntimeVector,
} from '../../../../../../packages/shared/src/runtime-eval.js';
