import type { PolicyMatcher, PolicySuggestion } from '@/lib/api';

export const POLICY_TYPE_LABELS: Record<PolicySuggestion['type'], string> = {
  prompt_injection: '提示词注入拦截',
  sensitive_data: '敏感信息脱敏',
  content_category: '内容类别拦截',
  tool_restriction: '工具调用限制',
};

export const POLICY_ACTION_LABELS: Record<string, string> = {
  block: '阻断',
  alert: '告警',
  mask: '脱敏',
};

export const POLICY_STATUS_LABELS: Record<string, string> = {
  DRAFT: '草稿',
  ACCEPTED: '已采纳',
  MODIFIED: '已修改',
  REJECTED: '驳回',
  DISPATCHED: '已下发',
  GATEWAY_PENDING: '网关待审批',
  PUBLISHED: '已发布',
  GATEWAY_REJECTED: '网关驳回',
};

export const MATCHER_KIND_LABELS: Record<PolicyMatcher['kind'], string> = {
  regex: '正则',
  keywords: '关键词',
  field_names: '字段名',
};

export const RETEST_STATUS_LABELS: Record<string, string> = {
  RUNNING: '复测进行中',
  COMPLETED: '复测完成',
  SERVICE_UNAVAILABLE: '待复测：复测服务未接入',
  LAUNCH_FAILED: '复测发起失败',
  NO_FAILED_QUESTIONS: '无需复测：原任务无失败用例',
  PARENT_NOT_FINISHED: '待复测：原任务未结束',
  NOT_SUPPORTED: '该任务类型不支持失败用例复测',
  FINDING_SCOPE_MISMATCH: '复测未发起：风险发现不属于原任务',
  REMEDIATION_CLOSED: '复测未发起：整改项已验证关闭',
  TARGET_NOT_EXECUTABLE: '复测未发起：评估对象不可执行',
  ACTOR_MISSING: '复测未发起：无法确定复测发起人',
  FAILED: '复测任务失败',
  CANCELED: '复测任务已取消',
};

export const GATEWAY_UNSUPPORTED_TEXT = '当前网关版本未开放策略下发接口，可导出后手工导入';
export const TYPE_EXPORT_ONLY_TEXT = '网关暂不支持此类型，仅可导出';

/** 状态色：仅成功/风险两类用彩色，其余灰。 */
export function statusTone(status: string): string {
  if (status === 'PUBLISHED') return 'text-[#1B7A46]';
  if (status === 'REJECTED' || status === 'GATEWAY_REJECTED') return 'text-[#B42318]';
  if (status === 'GATEWAY_PENDING') return 'text-[#B04A05]';
  return 'text-slate-600';
}

export function pct(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${Math.round(value * 1000) / 10}%`;
}

export function matcherSummary(m: PolicyMatcher): string {
  const value = Array.isArray(m.value) ? m.value.join('、') : m.value;
  return `${MATCHER_KIND_LABELS[m.kind]}：${value.length > 60 ? `${value.slice(0, 60)}…` : value}`;
}

/** 编辑框文本 → matcher：列表类一行一项。 */
export function parseMatcherInput(kind: PolicyMatcher['kind'], text: string): PolicyMatcher {
  if (kind === 'regex') return { kind, value: text.trim() };
  const value = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return { kind, value };
}

export function matcherToInput(m: PolicyMatcher): string {
  return Array.isArray(m.value) ? m.value.join('\n') : m.value;
}

/** 浏览器端下载 JSON（导出件内容与网关 POST body 一致）。 */
export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
