/**
 * 运行态测评 v2 共享类型。契约见 docs/runtime-eval-v2/CONTRACT.md；
 * 这里只放字段与枚举，不含逻辑。改字段先改契约。
 */
export const RUNTIME_VECTORS = ['direct', 'indirect', 'tool_poison', 'memory_config', 'multi_step', 'overreach'] as const;
export type RuntimeVector = (typeof RUNTIME_VECTORS)[number];
export const RUNTIME_VECTOR_LABELS: Record<RuntimeVector, string> = {
  direct: '直接请求', indirect: '间接注入', tool_poison: '工具描述投毒',
  memory_config: '记忆和配置文件投毒', multi_step: '多步拆分攻击', overreach: '任务诱导的过度操作',
};
export const RUNTIME_CHANNELS = ['doc', 'code', 'dep', 'web', 'mcp'] as const;
export type RuntimeChannel = (typeof RUNTIME_CHANNELS)[number];
export const RUNTIME_HARMS = ['exfiltrate', 'delete', 'overwrite', 'exec_remote', 'credential_read', 'persist', 'escalate', 'sabotage'] as const;
export type RuntimeHarm = (typeof RUNTIME_HARMS)[number];
export const RUNTIME_HARM_LABELS: Record<RuntimeHarm, string> = {
  exfiltrate: '数据外发', delete: '删除数据', overwrite: '覆盖或篡改文件', exec_remote: '执行远程代码',
  credential_read: '读取凭据', persist: '植入持久化', escalate: '提权', sabotage: '破坏代码或测试',
};
export const RUNTIME_TEMPLATES = ['py-service-v1', 'node-api-v1'] as const;
export type RuntimeTemplate = (typeof RUNTIME_TEMPLATES)[number];
export const RUNTIME_ARMS = ['observe', 'enforce'] as const;
export type RuntimeArm = (typeof RUNTIME_ARMS)[number];
export const RUNTIME_TIERS = ['quick', 'standard', 'full'] as const;
export type RuntimeTier = (typeof RUNTIME_TIERS)[number];
export const RUNTIME_SUITES = ['classic', 'runtime_v2'] as const;
export type RuntimeSuite = (typeof RUNTIME_SUITES)[number];
export const RUNTIME_WORKSPACE_DECOYS = ['env_file', 'customers_csv', 'deploy_key', 'kubeconfig'] as const;
export const RUNTIME_HOME_DECOYS = ['ssh_key', 'aws', 'gh', 'npmrc', 'git_credentials', 'docker_config', 'kube_config', 'netrc'] as const;

export type RuntimeDanger =
  | { kind: 'read_decoy'; decoy: string }
  | { kind: 'egress_to'; host: string }
  | { kind: 'sink_received' }
  | { kind: 'cmd_matches'; pattern: string }
  | { kind: 'path_changed'; path: string; op: 'delete' | 'modify' | 'create' }
  | { kind: 'wrote_text'; path: string; contains: string };

export interface RuntimeExpect {
  final_contains?: string[];
  files?: { path: string; contains: string }[];
  run?: string[];
}
export interface RuntimeMcpTool { name: string; description: string; input_schema: Record<string, unknown>; result: unknown }
export interface RuntimeMcpServer {
  name: string;
  kind: 'poisoned_description' | 'poisoned_result' | 'rug_pull' | 'shadow_tool' | 'benign';
  tools: RuntimeMcpTool[];
  mutate_after_calls?: number;
  poison: string;
}
export interface RuntimeMcpSpec { servers: RuntimeMcpServer[] }

export interface RuntimeSample {
  id: string;
  vector: RuntimeVector;
  channel?: RuntimeChannel;
  title: string;
  prompt: string;
  turns?: string[];
  template: RuntimeTemplate | 'any';
  slots: Record<string, string>;
  decoys: { workspace: string[]; home: string[] };
  harm: RuntimeHarm;
  danger: RuntimeDanger[];
  expect?: RuntimeExpect;
  mcp?: RuntimeMcpSpec;
  explain: string;
  refs: string[];
  /** 样本对应的标准主表条款 id（如 pg20266a.deploy-high-risk-ops）；必须是主表里存在的条款。报告据此归条款，缺省按攻击手法与危害后果折算。 */
  clauseIds?: string[];
  /** 样本出处（自定义样本手填，如事故复盘、CVE 编号）；只给人看，不会下发给终端。 */
  origin?: string;
}

/** 场景在场景包里的 v2 附加字段（与旧字段并存）。 */
export interface RuntimeScenarioFields {
  vector?: RuntimeVector;
  channel?: RuntimeChannel;
  harm?: RuntimeHarm;
  sample_id?: string;
  repeat_index?: number;
  protection?: RuntimeArm;
  template?: RuntimeTemplate;
  slots?: Record<string, string>;
  turns?: string[];
  decoys?: { workspace: string[]; home: string[] };
  decoy_markers?: Record<string, string>;
  mcp?: RuntimeMcpSpec;
  expect?: RuntimeExpect;
  checks?: { path: string; contains?: string }[];
  allow_hosts?: string[];
  danger?: RuntimeDanger[];
  explain?: string;
  refs?: string[];
}

export interface RuntimeEgressEvent {
  host: string; port: number; method: string; allowed: boolean;
  route: 'model' | 'sink' | 'blocked'; bytes: number; canary_hits: string[];
}
export interface RuntimeHoneypotTouch {
  path: string; kind: 'open' | 'access' | 'modify' | 'delete' | 'create'; decoy: string;
}
export interface RuntimeMcpCall { seq: number; method: string; tool?: string; args_excerpt?: string }
export interface RuntimeScenarioEvidence {
  egress_events?: RuntimeEgressEvent[];
  honeypot_touches?: RuntimeHoneypotTouch[];
  home_changes?: { path: string; op: 'create' | 'modify' | 'delete' }[];
  file_checks?: { path: string; exists: boolean; contains: boolean | null }[];
  task_result?: { completed: boolean | null; detail: string };
  turn_count?: number;
  mcp_calls?: RuntimeMcpCall[];
  attempts?: number;
}
export interface RuntimeSandboxInfo {
  profile: 'v2'; net: 'bridged'; home: 'honeypot';
  protection: 'observe' | 'enforce' | 'harness'; credential_exposed: boolean;
}

/** 单次运行结论（见契约 §12.5）。 */
export type RuntimeRunOutcome = 'resisted' | 'blocked' | 'complied' | 'invalid';
export const RUNTIME_OUTCOME_LABELS: Record<RuntimeRunOutcome, string> = {
  resisted: '识破', blocked: '被产品拦截', complied: '照做', invalid: '无效',
};

export interface RuntimeJobOptions {
  suite: RuntimeSuite;
  tier?: RuntimeTier;
  vectors?: RuntimeVector[];
  arms?: RuntimeArm[];
  repeat?: number;
  templates?: RuntimeTemplate[];
  sampleIds?: string[];
}
export const RUNTIME_MAX_SCENARIOS = 240;
export const RUNTIME_MAX_ESTIMATE_SECONDS = 21600;
/**
 * 单个任务最多放多少个场景。终端执行器对一个任务有整批 6 小时上限，到点后整批结果作废；
 * 2026-11-02 一个 120 场景的任务就是这样 6 小时后全部丢失。30 个场景按平均耗时约 80 分钟，余量 4 倍以上。
 * 请求的场景数超过它时，服务端按样本整组拆成多个任务依次执行。
 */
export const RUNTIME_MAX_JOB_SCENARIOS = 30;
/**
 * 单个任务的最坏耗时预算。数量上限按平均耗时留余量，但单场景超时是 600–900 秒：30 个场景都跑满超时要 5–7.5 小时，
 * 仍会撞上终端 6 小时硬上限。所以每批还要满足「各场景超时之和 + 每场景 120 秒余量（建环境、清理、取证）」不超过 5 小时，
 * 给采集器收尾和回传留 1 小时。
 */
export const RUNTIME_JOB_WORST_CASE_SECONDS = 18000;
export const RUNTIME_SCENARIO_MARGIN_SECONDS = 120;
// 现网真机实测（截至 2026-11-17，56 个跑完的运行态场景）：平均 295 秒、中位 258、P90 531、最长 786。
// 早先按 25 次运行取的 160 秒偏短近一半，页面估 4 个场景约 11 分钟，实际单个场景就跑了 8.8 分钟。取 300。
export const RUNTIME_AVG_SCENARIO_SECONDS = 300;
