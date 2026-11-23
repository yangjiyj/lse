// 建议 → 契约 POST body（下发与手工导入导出共用同一结构）。
import type { PolicySuggestion } from '@prisma/client';
import type { GatewaySuggestionBody } from './gateway-client.js';
import { GATEWAY_SUPPORTED_TYPES, type SuggestionType } from './generator.js';
import type { Matcher, MatcherKind } from './regex-safety.js';

export function isGatewaySupportedType(type: string): boolean {
  return (GATEWAY_SUPPORTED_TYPES as readonly string[]).includes(type as SuggestionType);
}

export function rowMatcher(row: Pick<PolicySuggestion, 'matcherKind' | 'matcherValue'>): Matcher {
  const kind = row.matcherKind as MatcherKind;
  if (kind === 'regex') return { kind, value: String(row.matcherValue) };
  const list = Array.isArray(row.matcherValue) ? row.matcherValue.map(String) : [];
  return { kind, value: list };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

export function toGatewayBody(row: PolicySuggestion): GatewaySuggestionBody {
  const matcher = rowMatcher(row);
  const impact =
    row.estimatedImpact &&
    typeof row.estimatedImpact === 'object' &&
    !Array.isArray(row.estimatedImpact)
      ? (row.estimatedImpact as Record<string, unknown>)
      : {};
  return {
    external_id: row.externalId,
    source: 'lse',
    type: row.type,
    action: row.action as GatewaySuggestionBody['action'],
    payload: {
      [matcher.kind]: matcher.value,
      examples: stringList(row.examples),
      source_finding: {
        ids: row.sourceFindingIds,
        task_id: row.taskId,
        risk_category: row.riskCategory,
      },
      estimated_impact: {
        sample_count: impact.sampleCount ?? null,
        hit_count: impact.hitCount ?? null,
        coverage: impact.coverage ?? null,
        pass_sample_count: impact.passSampleCount ?? null,
        pass_sample_hits: impact.passSampleHits ?? null,
        description: impact.description ?? null,
      },
    },
  };
}
