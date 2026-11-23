import type { NotCheckedOwner } from './not-checked.js';

/**
 * 终端概览读模型。后端 GET /api/fleet/endpoints/:id/overview 返回，前端终端详情页直接渲染。
 * 本文件是车道 A（后端）与 B（前端）之间的契约，其余车道不得修改；需要改字段请在 LANE-REPORT.md 里提出。
 */
export type OverviewLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'REVIEW' | 'NOT_CHECKED';
/** risk=发现风险；review=命中但需人工确认（例如只出现在说明文档里）；clear=已检查无风险；not_checked=终端没检查。 */
export type OverviewAssetState = 'risk' | 'review' | 'clear' | 'not_checked';
export type OverviewRiskCategory =
  | 'agent'
  | 'permission'
  | 'credential'
  | 'blast'
  | 'data'
  | 'skill'
  | 'mcp'
  | 'coverage'
  | 'platform';

/** 待确认行（命中只出现在说明文档或缺少可执行位置）的固定文案：终端页与任务页共用。 */
export const REVIEW_ROW = {
  title: '技能文档命中需要人工确认',
  basis: '检查命中出现在说明文档或缺少可执行位置证据。',
  advice: '核对命中文件与上下文，确认实际执行行为后再决定是否整改。',
} as const;

/** 没检查行里的一类成因：点开后逐类说明原因、办法和涉及的对象。 */
export interface EndpointRiskGroup {
  /** 成因键，见 not-checked 词表。 */
  cause: string;
  title: string;
  basis: string;
  advice: string;
  subjectCount: number;
  subjects: Array<{ name: string; detail: string }>;
  moreCount: number;
}

export interface EndpointRiskRow {
  /** 稳定键：同一问题多次检测保持不变（规则 + 涉及对象指纹），前端用作 React key 与定位。 */
  id: string;
  level: OverviewLevel;
  category: OverviewRiskCategory;
  /** 一句话中文标题，不超过 30 字，不含英文内部字段名。 */
  title: string;
  /** 已聚合的涉及对象，例如「5 个智能体所在账号」「Claude Code、Codex」。 */
  involved: string;
  /** 依据：探针看到了什么，一句话。 */
  basis: string;
  /** 怎么处理，一句话。 */
  advice: string;
  /** 仅 NOT_CHECKED 行：谁来处理这项没检查；缺失表示旧响应，前端不分组。 */
  owner?: NotCheckedOwner;
  /** 仅 NOT_CHECKED 行：按成因分组的说明；缺失表示旧响应，前端退回 basis/advice/subjects。 */
  groups?: EndpointRiskGroup[];
  subjectCount: number;
  /** 明细（最多 50 条），其余只给 moreCount。 */
  subjects: Array<{ name: string; detail: string }>;
  moreCount: number;
}

export interface EndpointAgentRow {
  /** 产品键，例如 claude-code；同一产品多处安装合并为一行。 */
  key: string;
  name: string;
  version: string | null;
  installs: number;
  /**
   * 配置读取状态；默认值不代表无风险，风险结论以探针检查为准。
   * unrecorded 只出现在历史任务页：任务当时没有保存读取状态，不是终端没读到。
   */
  configState:
    | 'checked'
    | 'default'
    | 'partial'
    | 'internal_store'
    | 'read_failed'
    | 'not_checked'
    | 'unrecorded';
  configItems: Array<{
    item: 'permission' | 'auto_approval' | 'sandbox';
    state: 'explicit' | 'default' | 'internal_store' | 'read_failed' | 'unknown';
    installs: number;
  }>;
  configNote: string | null;
  issues: number;
  liveEval: { supported: boolean; registered: boolean; reason: string | null };
  /** 仅 claude-code：终端心跳上报了 eval_sandbox_v2，可以发起运行态测评；其它智能体不带该字段。检测弹窗靠它启用「运行态测评」。 */
  runtimeV2?: boolean;
  /** 安装位置（主目录相对路径），仅任务页按安装逐行展示时提供。 */
  location?: string | null;
  /** 安装所属账号名，仅任务页按安装逐行展示时提供。 */
  account?: string | null;
  /** 同一份程序在这些系统账号下也被发现，没有可读的配置，不单独计为安装。 */
  ignoredAccounts?: string[];
  /** 各处安装版本不一致时，除 version（最高版本）以外的其余版本，由高到低。 */
  otherVersions?: string[];
}

/** 平台分类沿用探针封闭词表，配置读取仅表示覆盖情况。 */
export const PLATFORM_CHECK_LABELS = {
  secret_key: '应用密钥',
  db_credential: '数据库与缓存口令',
  internal_key: '组件互访密钥',
  admin_auth: '管理端鉴权',
  signup: '开放注册',
  code_exec: '代码执行隔离',
  ssrf: '请求伪造防护',
  exposure: '敏感端口',
  telemetry: '遥测外发',
  version: '版本漏洞',
  config_read: '配置读取',
} as const;
export type EndpointPlatformRule = keyof typeof PLATFORM_CHECK_LABELS;
export interface EndpointPlatformRow {
  key: string;
  name: string;
  version: string | null;
  containers: number;
  running: number;
  exposedPorts: number;
  checks: Array<{
    rule: EndpointPlatformRule;
    state: 'risk' | 'clear' | 'unread';
    containers: number;
    /** 探针判断原因原文，去重后供详情展示。 */
    reasons?: string[];
    /** 仅 state=risk：探针给出的整改建议原文，去重后供详情展示。 */
    advices?: string[];
    /** 仅 state=unread：没读到的成因键（见 not-checked 词表），缺失表示旧响应。 */
    cause?: string;
  }>;
  readState: 'complete' | 'partial' | 'not_checked';
  issues: number;
}

/** 技能命中规则 → 受控中文说明，不回显脚本内容。 */
const SKILL_HIT_LABELS: Readonly<Record<string, string>> = {
  'skill.instruction_write': '命中指令文件写入规则',
  'skill.persistence': '命中长期自动运行规则',
  'skill.destructive_delete': '命中文件删除规则',
  'skill.credential_access': '命中凭据读取规则',
  'skill.pipe_shell': '命中下载并运行规则',
  'skill.instruction_override': '命中覆盖安全指令规则',
  'skill.script_patterns': '命中脚本行为规则',
  'skill.network_upload': '命中内容上传规则',
  'skill.encoded_execution': '命中隐藏内容执行规则',
};

const SCRIPT_FILE =
  /\.(?:sh|bash|zsh|fish|py|pyw|js|mjs|cjs|jsx|ts|tsx|ps1|psm1|bat|cmd|rb|pl|php|lua|go|rs|exe|com)$/i;
/** 命中文件是可执行脚本：是则按需处理，否则（说明文档或位置不明）只需人工确认。 */
export const isScriptFile = (fileLabel: unknown): boolean =>
  typeof fileLabel === 'string' && SCRIPT_FILE.test(fileLabel);

export interface EndpointSkillHit {
  rule: string;
  /** 受控中文说明，不回显脚本内容。 */
  label: string;
  file: string | null;
  line: number | null;
  contextType: 'document' | 'code_block' | 'script' | 'unknown';
}

/** 终端上报的一条技能命中 → 展示用命中：说明取自受控词表，文件只留文件名，终端页与任务页共用。 */
export function skillHitFromCheck(check: {
  rule_id?: unknown;
  file_label?: unknown;
  line_number?: unknown;
  context_type?: unknown;
}): EndpointSkillHit {
  const rule = typeof check.rule_id === 'string' ? check.rule_id : '';
  const file = (typeof check.file_label === 'string' ? check.file_label : '')
    .split(/[\\/]/)
    .pop()
    ?.replace(/[\x00-\x1f]/g, '')
    .slice(0, 160);
  return {
    rule,
    label: SKILL_HIT_LABELS[rule] || '命中技能检查规则',
    file: file || null,
    line: typeof check.line_number === 'number' ? check.line_number : null,
    contextType:
      check.context_type === 'document'
        ? 'document'
        : check.context_type === 'code_block'
          ? 'code_block'
          : isScriptFile(check.file_label)
            ? 'script'
            : 'unknown',
  };
}

export interface EndpointSkillRow {
  name: string;
  /** 本地目录 / 官方市场缓存 / 插件缓存 / 来源未知 */
  sourceLabel: string;
  sourceState: 'known' | 'unknown';
  /** 装在哪些智能体里（去重后的展示名）。 */
  installedIn: string[];
  installs: number;
  state: OverviewAssetState;
  hits: EndpointSkillHit[];
  /** 有没检查的项时的成因键（见 not-checked 词表），即使整体状态已是待确认或需处理；缺失表示旧响应。 */
  cause?: string;
}

export interface EndpointMcpRow {
  name: string;
  transport: string | null;
  scope: string | null;
  installedIn: string[];
  state: OverviewAssetState;
  checks: Array<{
    label: string;
    state: 'pass' | 'finding' | 'unknown';
    /** 仅 state=unknown：没检查的成因键，缺失表示旧响应。 */
    cause?: string;
  }>;
}

export interface EndpointCheckHistoryRow {
  taskId: string;
  mode: 'posture' | 'live';
  /** 配置体检 / 真机测评 / 防护拦截验证 */
  modeLabel: string;
  createdAt: string;
  status: string;
  summaryLine: string;
  agentName?: string | null;
  sampleCount?: number | null;
}

export interface EndpointOverviewCounts {
  platformKinds?: number;
  platformContainers?: number;
  openRisks: number;
  highRisks: number;
  reviewItems: number;
  agentKinds: number;
  agentInstalls: number;
  skills: number;
  mcpServers: number;
  notCheckedKinds: number;
  notCheckedInstalls: number;
  /** 其中需要管理员处理的行数；缺失表示旧响应。 */
  notCheckedAdmin?: number;
}

export interface EndpointOverview {
  endpointId: string;
  report: { reportId: string; scannedAt: string | null; probeVersion: string | null } | null;
  counts: EndpointOverviewCounts;
  risks: EndpointRiskRow[];
  agents: EndpointAgentRow[];
  platforms: EndpointPlatformRow[];
  skills: EndpointSkillRow[];
  mcp: EndpointMcpRow[];
  history: EndpointCheckHistoryRow[];
}
