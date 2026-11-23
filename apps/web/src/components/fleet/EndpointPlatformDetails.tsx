import {
  PLATFORM_CHECK_LABELS,
  type EndpointPlatformRow,
} from '../../../../../packages/shared/src/endpoint-overview';
import { Badge } from '@/components/ui/badge';
import { CauseBlock, causeOf } from './DrawerParts';

const visibleChecks = (p: EndpointPlatformRow) => p.checks.filter((c) => c.rule !== 'config_read');
export function platformPorts(p: EndpointPlatformRow): string {
  if (p.exposedPorts) return `${p.exposedPorts} 个对外`;
  return p.readState === 'not_checked' ||
    !p.checks.some((c) => c.rule === 'exposure') ||
    p.checks.some((c) => c.rule === 'exposure' && c.state === 'unread')
    ? '没读到'
    : '无';
}
export function platformStatus(p: EndpointPlatformRow): string {
  if (p.readState === 'not_checked') return '未体检';
  const risks = visibleChecks(p).filter((c) => c.state === 'risk');
  const unknown = visibleChecks(p).filter((c) => c.state === 'unread').length;
  return [
    risks.map((c) => PLATFORM_CHECK_LABELS[c.rule]).join('、'),
    unknown ? `${unknown} 项没读到` : '',
    !risks.length && !unknown
      ? p.readState === 'complete' && visibleChecks(p).length
        ? '已检查无风险'
        : '没读到'
      : '',
  ]
    .filter(Boolean)
    .join('；');
}
export function PlatformChecks({ platform: p }: { platform: EndpointPlatformRow }) {
  if (p.readState === 'not_checked') return <>未体检</>;
  const risk = visibleChecks(p).filter((c) => c.state === 'risk');
  const unknown = visibleChecks(p).filter((c) => c.state === 'unread').length;
  if (!risk.length) return <>{platformStatus(p)}</>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {risk.slice(0, 3).map((c) => (
        <Badge tone="danger" key={c.rule}>
          {PLATFORM_CHECK_LABELS[c.rule]}
        </Badge>
      ))}
      {risk.length > 3 && (
        <details onClick={(event) => event.stopPropagation()}>
          <summary className="cursor-pointer">+{risk.length - 3}</summary>
          <div className="flex flex-wrap gap-2">
            {risk.slice(3).map((c) => (
              <Badge tone="danger" key={c.rule}>
                {PLATFORM_CHECK_LABELS[c.rule]}
              </Badge>
            ))}
          </div>
        </details>
      )}
      {unknown > 0 && <span className="text-ink-3">{unknown} 项没读到</span>}
    </div>
  );
}

/** 抽屉标题下的元信息：版本、容器数，有对外端口时用红字单独点出。 */
export function platformSubtitle(p: EndpointPlatformRow) {
  return (
    <span>
      {[p.version || '版本未知', `${p.running}/${p.containers} 个容器运行中`].join(' · ')}
      {p.exposedPorts > 0 && <span className="text-[#B42318]"> · {p.exposedPorts} 个对外端口</span>}
    </span>
  );
}

type PlatformCheck = EndpointPlatformRow['checks'][number];

/** 原因和办法完全相同的风险项合并成一块，同一句话只写一次。 */
function groupRisks(risks: PlatformCheck[]) {
  const groups = new Map<
    string,
    { checks: PlatformCheck[]; reasons: string[]; advices: string[] }
  >();
  for (const check of risks) {
    const reasons = [...new Set(check.reasons ?? [])];
    const advices = [...new Set(check.advices ?? [])];
    const key = JSON.stringify([reasons, advices]);
    const group = groups.get(key) ?? { checks: [], reasons, advices };
    group.checks.push(check);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * 平台抽屉按结果分三块：发现风险（附探针的原因和整改建议）、没读到（按成因说明）、已检查无风险（折起）。
 * 判断依据原文只在对应的风险或没读到项下出现一次。
 */
export function PlatformDetails({ platform: p }: { platform: EndpointPlatformRow }) {
  if (p.readState === 'not_checked') {
    const cause = causeOf('platform_not_assessed');
    return (
      <CauseBlock
        title={cause.title}
        basis={cause.basis}
        advice={cause.advice}
        owner={cause.owner}
      />
    );
  }
  const risks = p.checks.filter((c) => c.state === 'risk');
  const unread = p.checks.filter((c) => c.state === 'unread');
  const clear = p.checks.filter((c) => c.state === 'clear' && c.rule !== 'config_read');
  const causeKeys = [...new Set(unread.map((c) => c.cause ?? 'platform_unread'))];
  return (
    <>
      {risks.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-sm font-semibold leading-6">发现风险</h3>
            <span className="text-xs tabular-nums text-ink-3">{risks.length} 项</span>
          </div>
          <ul className="divide-y divide-line">
            {groupRisks(risks).map((group) => (
              <li
                key={group.checks.map((c) => c.rule).join()}
                className="space-y-1 py-3 first:pt-0 last:pb-0"
              >
                <div className="font-medium">
                  {group.checks
                    .map(
                      (c) =>
                        `${PLATFORM_CHECK_LABELS[c.rule]}${
                          c.containers !== p.containers ? `（${c.containers} 个容器）` : ''
                        }`,
                    )
                    .join('、')}
                </div>
                {group.reasons.map((reason) => (
                  <p key={reason}>{reason}</p>
                ))}
                {group.advices.map((advice) => (
                  <p key={advice} className="text-ink-2">
                    <span className="mr-1.5 font-medium text-ink">办法</span>
                    {advice}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}
      {causeKeys.map((key) => {
        const cause = causeOf(key);
        const rules = unread
          .filter((c) => (c.cause ?? 'platform_unread') === key)
          .map((c) => PLATFORM_CHECK_LABELS[c.rule]);
        return (
          <CauseBlock
            key={key}
            title={cause.title}
            meta={[...new Set(rules)].join('、')}
            basis={cause.basis}
            advice={cause.advice}
            owner={cause.owner}
          />
        );
      })}
      {clear.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs font-medium text-ink-3">
            已检查无风险 {clear.length} 项
          </summary>
          <ul className="mt-1 divide-y divide-line">
            {clear.map((c) => (
              <li key={c.rule} className="flex items-center justify-between gap-3 py-1.5">
                <span>{PLATFORM_CHECK_LABELS[c.rule]}</span>
                {c.containers !== p.containers && (
                  <span className="text-xs text-ink-3">{c.containers} 个容器</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
