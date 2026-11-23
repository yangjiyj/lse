import { config } from '../../config.js';
import { RULE_JUDGE_ENGINE, SENSITIVE_INFO_ENGINE } from '../eval-tasks/rule-judge.js';
import { GARAK_ENGINE } from './garak.js';
import { PYRIT_ENGINE } from './pyrit.js';
import { PYTHON_JUDGE_ENGINE } from './python-judge.js';
import { LLM_JUDGE_ENGINE } from './llm-judge.js';
import { AGENT_TOOL_GUARD_ENGINE } from './agent-tool-guard.js';
import { AGENT_LLM_JUDGE_ENGINE } from './agent-llm-judge.js';

export type EngineKind = 'per-question' | 'task-level';

export interface EngineCatalogEntry {
  /** 引擎稳定标识，与 EvalTask.engines[] 取值一致。 */
  engine: string;
  /** per-question 逐题判定 / task-level 任务级扫描。 */
  kind: EngineKind;
  /** 是否内置纯函数引擎（恒可用、零依赖）。 */
  builtin: boolean;
  /** 中文展示名。 */
  label: string;
  /** 中文说明。 */
  description: string;
  /** 当前运行环境下是否真正可用（内置恒 true；外部受门控与开关约束）。 */
  isEnabled: () => boolean;
}

/**
 * 测试模式（LSE_TEST=1）下强制关闭一切外部引擎：
 * 既保证既有用例 EngineRun 断言稳定，也避免单测意外发起真实网络请求。
 */
function externalsEnabled(): boolean {
  return process.env.LSE_TEST !== '1';
}

/** 平台已知引擎目录：注册新引擎时只需在此追加一项即可被选择器与 API 同时感知。 */
export const ENGINE_CATALOG: EngineCatalogEntry[] = [
  {
    engine: RULE_JUDGE_ENGINE,
    kind: 'per-question',
    builtin: true,
    label: '规则判定引擎',
    description: '内置逐题判定：关键词/正则/应拒答规则，零依赖、恒可用。',
    isEnabled: () => true,
  },
  {
    engine: SENSITIVE_INFO_ENGINE,
    kind: 'per-question',
    builtin: true,
    label: '敏感信息检测',
    description: '内置敏感信息（手机号/邮箱/密钥等）泄露检测，零依赖、恒可用。',
    isEnabled: () => true,
  },
  {
    engine: AGENT_TOOL_GUARD_ENGINE,
    kind: 'per-question',
    builtin: true,
    label: 'Agent 工具调用守卫',
    description:
      '内置可选逐题判定：识别 metadata IP、本地文件、环境变量和危险命令等工具滥用信号。' +
      'Agent/API/MCP 类被测对象默认启用，覆盖 MCP tools/call 参数级越权信号。',
    isEnabled: () => true,
  },
  {
    engine: PYTHON_JUDGE_ENGINE,
    kind: 'per-question',
    builtin: false,
    label: 'Python 判定 Sidecar',
    description: '可选 Python 判定服务（llm-guard 等），需部署 sidecar 并开启开关。',
    isEnabled: () => externalsEnabled() && config.PYTHON_JUDGE_ENABLED,
  },
  {
    engine: GARAK_ENGINE,
    kind: 'task-level',
    builtin: false,
    label: 'garak 漏洞探针扫描',
    description: 'garak（NVIDIA）任务级越狱/注入探针扫描，需部署 sidecar 并开启开关。',
    isEnabled: () => externalsEnabled() && config.GARAK_ENABLED,
  },
  {
    engine: PYRIT_ENGINE,
    kind: 'task-level',
    builtin: false,
    label: 'PyRIT 多轮红队评估',
    description: 'PyRIT（Microsoft）多轮自动化红队评估，需部署 sidecar 并启用相关配置。',
    isEnabled: () => externalsEnabled() && config.PYRIT_ENABLED,
  },
  {
    engine: LLM_JUDGE_ENGINE,
    kind: 'per-question',
    builtin: false,
    label: 'AI 评审复核',
    description:
      'LLM-as-judge 逐样本语义判定（失败时保留辅助依据并标记判定未完成）；配置并启用全局判定模型后可用。',
    isEnabled: () => externalsEnabled() && config.LLM_JUDGE_ENABLED,
  },
  {
    engine: AGENT_LLM_JUDGE_ENGINE,
    kind: 'per-question',
    builtin: false,
    label: '智能体工具调用语义判定',
    description:
      '面向智能体运行时与 MCP 工具调用的模型判定能力：从工具选择、参数安全、二次确认、注入隔离和任务匹配五个维度评估越权风险，与智能体工具守卫的规则判定互补。复用全局判定模型或 LLM_JUDGE_* 环境变量。',
    isEnabled: () => externalsEnabled() && config.LLM_JUDGE_ENABLED,
  },
];

/** 某引擎在当前运行环境下是否可用（registry 据此构造实例、API 据此返回 available）。 */
export function isEngineEnabled(engine: string): boolean {
  const entry = ENGINE_CATALOG.find((e) => e.engine === engine);
  return entry ? entry.isEnabled() : false;
}

export interface EngineCatalogItem {
  engine: string;
  kind: EngineKind;
  builtin: boolean;
  available: boolean;
  label: string;
  description: string;
}

/** 序列化引擎目录（含运行期 available），供 GET /api/engines 返回。 */
export function engineCatalog(): EngineCatalogItem[] {
  return ENGINE_CATALOG.map((e) => ({
    engine: e.engine,
    kind: e.kind,
    builtin: e.builtin,
    available: e.isEnabled(),
    label: e.label,
    description: e.description,
  }));
}
