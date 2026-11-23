import type { CheckCatalog, FleetPostureFinding } from '@/lib/api';
import {
  EndpointConclusion,
  KeyMetricCards,
  RiskCategoryCard,
  RiskLevelBadge,
  type SafetyState,
} from './safety/EndpointSafety';

export const severityLabel = { HIGH: '高危', MEDIUM: '中危', LOW: '低危' } as const;

/** 这里只有三态，待确认没有单独的展示位：与未知状态一样按没检查呈现，不当成无风险。 */
const threeState = (state: FleetPostureFinding['state']): SafetyState | undefined =>
  state === 'review' ? 'not_checked' : state;

export function RiskSummary({
  catalog,
  findings,
}: {
  catalog: CheckCatalog;
  findings: FleetPostureFinding[];
}) {
  if (!findings.length)
    return <p className="text-sm text-ink-3">还没有检测结果，点「一键检测」开始</p>;
  const groups = [...catalog.categories]
    .sort((a, b) => a.order - b.order)
    .map((category) => ({
      ...category,
      items: findings.filter(
        (f) => catalog.posture.find((c) => c.id === f.ruleId)?.category === category.id,
      ),
    }));
  const unmatched = findings.filter((f) => !catalog.posture.some((c) => c.id === f.ruleId));
  if (unmatched.length)
    groups.push({ id: 'behavior', label: '其他检测项', order: 999, items: unmatched });
  const risks = groups.filter((g) => g.items.some((f) => f.verdict === 'FAIL'));
  const high = risks.filter((g) =>
    g.items.some((f) => f.verdict === 'FAIL' && f.severity === 'HIGH'),
  ).length;
  const unknown = findings.reduce(
    (count, f) =>
      count +
      Math.max(
        (f.subjects ?? []).filter((s) => s.state === 'not_checked').length,
        f.verdict === 'UNKNOWN' ? 1 : 0,
      ),
    0,
  );
  return (
    <div className="space-y-3">
      <EndpointConclusion showState={false}
        state={risks.length ? 'risk' : unknown ? 'not_checked' : 'clear'}
        verdictLine={risks.length
          ? `这台电脑上发现 ${risks.length} 类风险，其中 ${high} 类高危`
          : unknown
            ? '部分检测项无法判断，暂不能确认安全'
            : '本次采集范围内未发现风险'}
      />
      <KeyMetricCards metrics={[
        { label: '风险类别', value: risks.length, unit: '类' },
        { label: '高危类别', value: high, unit: '类' },
        { label: '终端没有检查', value: unknown, unit: '项' },
      ]} />
      {unknown > 0 && (
        <p className="text-sm text-ink-3">
          另有 {unknown} 项终端没有检查，原因和办法见下。不同检查项可能涉及同一个对象。
        </p>
      )}
      {groups
        .filter((g) => g.items.length)
        .map((g) => {
          const failures = g.items.filter((f) => f.verdict === 'FAIL');
          const highest = ['HIGH', 'MEDIUM', 'LOW'].find((s) =>
            failures.some((f) => f.severity === s),
          ) as FleetPostureFinding['severity'] | undefined;
          return (
            <RiskCategoryCard key={g.label} title={g.label}
              description={`命中 ${failures.length} / ${g.items.length} 项`}
              extra={highest && <RiskLevelBadge severity={highest} />}
              showAllGuidance showItemRiskLevel={false}
              findings={g.items.map(f => ({
                ...f,
                state: threeState(f.state) ?? (f.verdict === 'FAIL' ? 'risk' : f.verdict === 'PASS' ? 'clear' : 'not_checked'),
                subjects: f.subjects?.map(s => ({ ...s, state: threeState(s.state) })),
                plainTitle: f.plainTitle ?? f.title,
                notCheckedReason: f.notCheckedReason ?? '终端没有提供完成这一项检查所需的信息。',
                plainFix: f.plainFix ?? catalog.posture.find(c => c.id === f.ruleId)?.remediation ?? '目录未提供该项建议，请联系平台管理员确认。',
                evidence: f.evidence?.split(/ GB\/T 45654| 对照：/)[0],
              }))}
            />
          );
        })}
    </div>
  );
}
