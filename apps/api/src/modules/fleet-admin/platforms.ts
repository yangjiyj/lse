import { compare, valid, coerce } from 'semver';
import {
  PLATFORM_CHECK_LABELS,
  type EndpointPlatformRow,
  type EndpointPlatformRule,
  type EndpointRiskRow,
} from '../../../../../packages/shared/src/endpoint-overview.js';
import { arr, rec, str, type Rec } from './inventory.js';

const rules = Object.keys(PLATFORM_CHECK_LABELS) as EndpointPlatformRule[];
const unread = (c: Rec) =>
  c.status === 'unknown' ||
  ['platform_unread', 'platform_config_partial'].includes(str(c.evidence_code));
const state = (c: Rec): EndpointPlatformRow['checks'][number]['state'] =>
  unread(c) ? 'unread' : c.status === 'finding' ? 'risk' : c.status === 'pass' ? 'clear' : 'unread';
/** 平台这一项没读到的成因：镜像没写版本号归管理员，其余是探针现有能力的边界。 */
function unreadCause(rule: EndpointPlatformRule, check: Rec, asset: Rec): string {
  const code = str(check.evidence_code);
  if (code === 'platform_config_partial') return 'platform_config_partial';
  if (rule === 'version' && code === 'platform_version_unknown') {
    const version = str(asset.version) || str(rec(rec(asset.evidence).detail).platform_version);
    return !version || version === 'version_unknown'
      ? 'platform_image_no_version'
      : 'platform_version_unknown';
  }
  return 'platform_unread';
}
const severity = (c: Rec) => (c.severity === 'high' ? 2 : c.severity === 'medium' ? 1 : 0);
const checksOf = (asset: Rec) => arr(rec(rec(asset.evidence).static_assessment).checks);
const assessed = (asset: Rec) => rec(asset.evidence).static_assessment != null;
function versionOf(assets: Rec[]): string | null {
  const versions = [
    ...new Set(
      assets
        .map((a) => str(a.version) || str(rec(rec(a.evidence).detail).platform_version))
        .filter((v) => v && v !== 'version_unknown'),
    ),
  ];
  if (versions.length <= 1) return versions[0] ?? null;
  const parsed = versions.map(
    (v) => valid(v) || (/^v?\d+(\.\d+){0,2}$/.test(v) ? coerce(v)?.version : null),
  );
  if (parsed.some((v) => !v)) return null;
  return (
    versions
      .map((value, i) => ({ value, parsed: parsed[i]! }))
      .sort((a, b) => compare(b.parsed, a.parsed))[0]?.value ?? null
  );
}
/** 只取判断结果和容器定位，不读取或传播配置值、镜像及完整证据。 */
export function aggregatePlatforms(body: Rec): {
  platforms: EndpointPlatformRow[];
  risks: EndpointRiskRow[];
} {
  const groups = new Map<string, Rec[]>();
  for (const asset of arr(body.assets).filter((a) => a.kind === 'platform_container')) {
    const key = str(asset.name);
    if (key) groups.set(key, [...(groups.get(key) ?? []), asset]);
  }
  const risks: EndpointRiskRow[] = [];
  const platforms = [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, assets]): EndpointPlatformRow => {
      const name = str(assets[0]?.display_name) || key;
      const checks: EndpointPlatformRow['checks'] = [];
      const hasAssessment = assets.some(assessed);
      const complete = assets.every(
        (a) =>
          assessed(a) &&
          checksOf(a).some((c) => c.rule_id === 'platform.config_read' && state(c) === 'clear') &&
          checksOf(a).every((c) => !unread(c)),
      );
      for (const rule of rules) {
        const entries = assets.flatMap((asset, index) => {
          if (!hasAssessment) return [];
          const check = checksOf(asset).find((c) => c.rule_id === `platform.${rule}`);
          // 旧容器混入新上报时标为没读到，避免遗漏的类别被当成通过。
          return check
            ? [{ asset, index, check }]
            : !assessed(asset)
              ? [{ asset, index, check: { status: 'unknown' } as Rec }]
              : [];
        });
        for (const value of ['risk', 'clear', 'unread'] as const) {
          const matching = entries.filter((e) => state(e.check) === value);
          if (!matching.length) continue;
          // 没读到的按成因分开：同一项里有的容器缺版本号、有的缺对照表，办法不同。
          const groups = new Map<string | undefined, typeof matching>();
          for (const e of matching) {
            const cause = value === 'unread' ? unreadCause(rule, e.check, e.asset) : undefined;
            groups.set(cause, [...(groups.get(cause) ?? []), e]);
          }
          for (const [cause, group] of groups)
            checks.push({
              rule,
              state: value,
              containers: group.length,
              reasons: [...new Set(group.map((e) => str(e.check.reason_zh)).filter(Boolean))],
              ...(value === 'risk'
                ? {
                    advices: [
                      ...new Set(group.map((e) => str(e.check.recommendation_zh)).filter(Boolean)),
                    ],
                  }
                : {}),
              ...(cause ? { cause } : {}),
            });
        }
        if (rule === 'config_read') continue;
        const findings = entries.filter((e) => state(e.check) === 'risk');
        if (!findings.length) continue;
        const selected = [...findings].sort(
          (a, b) =>
            severity(b.check) - severity(a.check) ||
            str(a.check.reason_zh).localeCompare(str(b.check.reason_zh)),
        )[0]!;
        const subjects = findings.map(({ asset, index, check }) => ({
          name:
            str(rec(rec(asset.evidence).detail).container_id).slice(0, 12) || `容器 ${index + 1}`,
          detail: /^[^/\\:\x00-\x1f]{1,128}$/.test(str(check.file_label))
            ? str(check.file_label)
            : '',
        }));
        risks.push({
          id: `platform:${key}:${rule}`,
          category: 'platform',
          level:
            severity(selected.check) === 2
              ? 'HIGH'
              : severity(selected.check) === 1
                ? 'MEDIUM'
                : 'LOW',
          title: `${name} 的${PLATFORM_CHECK_LABELS[rule]}配置存在风险`,
          involved: `${findings.length} 个容器`,
          basis: str(selected.check.reason_zh),
          advice: str(selected.check.recommendation_zh),
          subjectCount: subjects.length,
          subjects: subjects.slice(0, 50),
          moreCount: Math.max(0, subjects.length - 50),
        });
      }
      return {
        key,
        name,
        version: versionOf(assets),
        containers: assets.length,
        running: assets.filter((a) => a.running === true).length,
        exposedPorts:
          checks.find((c) => c.rule === 'exposure' && c.state === 'risk')?.containers ?? 0,
        checks,
        readState: !hasAssessment ? 'not_checked' : complete ? 'complete' : 'partial',
        issues: checks.filter((c) => c.rule !== 'config_read' && c.state === 'risk').length,
      };
    });
  return { platforms, risks };
}
