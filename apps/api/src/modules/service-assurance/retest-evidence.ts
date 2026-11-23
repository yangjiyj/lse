import type { ServiceAssuranceCheckExecution } from '@lse/shared';

interface RiskEvidence {
  sourceTool: string;
  ruleId: string | null;
  matchedLocation: string | null;
}
export interface RetestRisk {
  assessmentKey: string;
  advisoryId: string | null;
  impactStatus: string;
  evidenceLevel: string;
  reviewedAt?: Date | null;
  component: { purl: string | null } | null;
  evidence: RiskEvidence[];
}

function packageIdentity(purl: string | null | undefined): string | null {
  if (!purl?.startsWith('pkg:')) return null;
  const suffixIndex = purl.search(/[?#]/);
  const path = suffixIndex < 0 ? purl : purl.slice(0, suffixIndex);
  const suffix = suffixIndex < 0 ? '' : purl.slice(suffixIndex);
  // Scoped npm names may contain @ before the last slash. Only remove a version.
  const versionIndex = path.lastIndexOf('@');
  const unversioned = versionIndex > path.lastIndexOf('/') ? path.slice(0, versionIndex) : path;
  return unversioned.replace(/%40/gi, '@') + suffix;
}

function location(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return value;
  }
}

export function assessOriginalRiskRetest(
  original: RetestRisk,
  results: RetestRisk[],
  checks: ServiceAssuranceCheckExecution[],
): { originalRiskCheckCompleted: boolean; remainingAffectedCount: number } {
  if (original.evidenceLevel === 'VERSION_MATCH') {
    const identity = packageIdentity(original.component?.purl);
    if (!identity || !original.advisoryId)
      return { originalRiskCheckCompleted: false, remainingAffectedCount: 0 };
    const samePackage = results.filter(
      (item) => packageIdentity(item.component?.purl) === identity,
    );
    const same = samePackage.filter((item) => item.advisoryId === original.advisoryId);
    const unresolved = samePackage.filter(
      (item) =>
        (item.advisoryId === original.advisoryId || !item.advisoryId) &&
        (item.reviewedAt != null ||
          item.impactStatus === 'AFFECTED' ||
          item.impactStatus === 'UNDER_INVESTIGATION'),
    );
    return {
      originalRiskCheckCompleted: same.some(
        (item) =>
          item.reviewedAt == null &&
          item.impactStatus === 'NOT_AFFECTED' &&
          item.evidenceLevel === 'VERSION_MATCH' &&
          item.evidence.length > 0,
      ),
      remainingAffectedCount: unresolved.length,
    };
  }
  const rules = original.evidence.filter(
    (item) => item.sourceTool.includes('nuclei') && item.ruleId,
  );
  const ids = [...new Set(rules.map((item) => item.ruleId!))];
  // Aggregate scanner success does not prove that this specific check ran.
  const completed =
    ids.length > 0 &&
    ids.every((id) => {
      const observed = checks.filter((item) => item.id === id);
      return (
        observed.length === 1 &&
        observed[0]!.status === 'COMPLETED' &&
        (observed[0]!.requestCount ?? 0) > 0
      );
    });
  const matching = results.filter((item) => {
    if (item.assessmentKey === original.assessmentKey) return true;
    return item.evidence.some((evidence) =>
      rules.some(
        (rule) =>
          rule.ruleId === evidence.ruleId &&
          rule.sourceTool === evidence.sourceTool &&
          (!rule.matchedLocation ||
            !evidence.matchedLocation ||
            location(rule.matchedLocation) === location(evidence.matchedLocation)),
      ),
    );
  });
  return {
    originalRiskCheckCompleted: completed,
    remainingAffectedCount: matching.filter(
      (item) =>
        item.reviewedAt != null ||
        item.impactStatus === 'AFFECTED' ||
        item.impactStatus === 'UNDER_INVESTIGATION',
    ).length,
  };
}
