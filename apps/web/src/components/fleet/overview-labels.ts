import type {
  EndpointAgentRow,
  OverviewAssetState,
  OverviewLevel,
  OverviewRiskCategory,
} from '../../../../../packages/shared/src/endpoint-overview';

export const stateLabels: Record<OverviewAssetState, string> = {
  risk: '需处理',
  review: '待确认',
  clear: '已检查无风险',
  not_checked: '终端没检查',
};

export const configLabels: Record<EndpointAgentRow['configState'], string> = {
  checked: '已读到',
  default: '按默认值',
  partial: '部分读到',
  internal_store: '不在配置文件里',
  read_failed: '读取失败',
  not_checked: '没读到',
  unrecorded: '任务未记录',
};

export const configItemLabels = {
  permission: '权限模式',
  auto_approval: '自动批准',
  sandbox: '沙箱',
} as const;

export const configItemStates: Record<EndpointAgentRow['configItems'][number]['state'], string> = {
  explicit: '已读到',
  default: '按默认值',
  internal_store: '不在配置文件里',
  read_failed: '读取失败',
  unknown: '没读到',
};

export const categoryLabels: Record<OverviewRiskCategory, string> = {
  agent: '智能体',
  permission: '权限',
  credential: '凭据',
  blast: '影响范围',
  data: '数据',
  skill: '技能',
  mcp: 'MCP',
  coverage: '检查覆盖',
  platform: '平台',
};

export const levelLabels: Record<OverviewLevel, string> = {
  HIGH: '高危',
  MEDIUM: '中危',
  LOW: '低危',
  REVIEW: '待确认',
  NOT_CHECKED: '没检查',
};

export const contextLabels = {
  document: '说明文档',
  code_block: '代码块',
  script: '脚本',
  unknown: '位置未知',
} as const;

export function transportLabel(transport: string | null | undefined): string {
  return transport === 'stdio'
    ? '本地进程'
    : transport === 'sse'
      ? '事件流'
      : transport === 'streamable-http' || transport === 'http'
        ? '网络请求'
        : transport
          ? '其他方式'
          : '未上报';
}

export function scopeLabel(scope: string | null | undefined): string {
  return scope === 'user' ? '用户' : scope === 'project' ? '项目' : scope || '未上报';
}
