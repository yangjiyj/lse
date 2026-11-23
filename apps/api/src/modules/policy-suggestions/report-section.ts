// 报告「推荐防护策略」章节数据：纯函数，从该任务相关的 PolicySuggestion 生成。
import type { PolicySuggestion } from '@prisma/client';
import { SUGGESTION_TYPE_LABELS, type SuggestionType } from './generator.js';
import { rowMatcher } from './export.js';

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

export const POLICY_ACTION_LABELS: Record<string, string> = {
  block: '阻断',
  alert: '告警',
  mask: '脱敏',
};

const MATCHER_KIND_LABELS: Record<string, string> = {
  regex: '正则',
  keywords: '关键词',
  field_names: '字段名',
};

export interface ProtectionStrategySection {
  headers: string[];
  rows: string[][];
  empty: boolean;
  note: string;
}

type Row = Pick<
  PolicySuggestion,
  | 'type'
  | 'action'
  | 'matcherKind'
  | 'matcherValue'
  | 'estimatedImpact'
  | 'status'
  | 'ruleSetVersion'
  | 'preAttackRate'
  | 'postAttackRate'
  | 'retestError'
  | 'sourceFindingIds'
>;

function pct(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${Math.round(value * 1000) / 10}%`
    : '—';
}

function matcherText(row: Row): string {
  const m = rowMatcher(row);
  const label = MATCHER_KIND_LABELS[m.kind] ?? m.kind;
  const value = Array.isArray(m.value) ? m.value.join('、') : m.value;
  const clipped = value.length > 160 ? `${value.slice(0, 160)}…` : value;
  return `${label}：${clipped}`;
}

function impactText(row: Row): string {
  const i = row.estimatedImpact;
  if (
    i &&
    typeof i === 'object' &&
    !Array.isArray(i) &&
    typeof (i as { description?: unknown }).description === 'string'
  ) {
    return (i as { description: string }).description;
  }
  return '—';
}

function compareText(row: Row): string {
  if (row.retestError) return `下发前 ${pct(row.preAttackRate)}；${row.retestError}`;
  if (row.preAttackRate == null && row.postAttackRate == null) return '未复测';
  return `下发前 ${pct(row.preAttackRate)} → 下发后 ${pct(row.postAttackRate)}`;
}

/** 驳回的建议不进入报告。 */
export function buildProtectionStrategySection(rows: Row[]): ProtectionStrategySection {
  const kept = rows.filter((r) => r.status !== 'REJECTED');
  return {
    headers: ['策略类型', '建议动作', '匹配规则', '预估影响', '状态', '攻击成功率对比'],
    rows: kept.map((r) => [
      SUGGESTION_TYPE_LABELS[r.type as SuggestionType] ?? r.type,
      POLICY_ACTION_LABELS[r.action] ?? r.action,
      matcherText(r),
      impactText(r),
      `${POLICY_STATUS_LABELS[r.status] ?? r.status}${r.ruleSetVersion ? `（规则集版本 ${r.ruleSetVersion}）` : ''}`,
      compareText(r),
    ]),
    empty: kept.length === 0,
    note: '策略由评估证据经确定性模板抽取生成，预估影响为在本次证据样本上的实测命中；下发后须经网关管理员审批方可生效。',
  };
}
