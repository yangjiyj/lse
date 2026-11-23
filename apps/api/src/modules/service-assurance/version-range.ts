import { compare, major, minor, valid } from 'semver';

const SEMVER_ECOSYSTEMS = new Set([
  'cargo',
  'composer',
  'generic',
  'golang',
  'maven',
  'npm',
  'nuget',
]);

export type VersionImpact = 'AFFECTED' | 'NOT_AFFECTED' | 'UNKNOWN';

function strictVersion(value: string): string | null {
  return valid(value.trim(), { loose: false });
}

export function classifyVersionAgainstFix(input: {
  ecosystem: string | null;
  installedVersion: string;
  fixedVersions: string;
}): VersionImpact {
  const ecosystem = input.ecosystem?.trim().toLowerCase() ?? '';
  if (!SEMVER_ECOSYSTEMS.has(ecosystem)) return 'UNKNOWN';
  const installed = strictVersion(input.installedVersion);
  if (!installed) return 'UNKNOWN';
  const fixes = input.fixedVersions
    .split(',')
    .map((item) => strictVersion(item))
    .filter((item): item is string => item !== null);
  if (fixes.length === 0) return 'UNKNOWN';

  const sameBranch = fixes
    .filter((fix) => major(fix) === major(installed) && minor(fix) === minor(installed))
    .sort(compare)
    .at(0);
  if (sameBranch) {
    return compare(installed, sameBranch) >= 0 ? 'NOT_AFFECTED' : 'AFFECTED';
  }

  const highest = [...fixes].sort(compare).at(-1)!;
  if (
    major(installed) > major(highest) ||
    (major(installed) === major(highest) && minor(installed) > minor(highest))
  ) {
    return 'NOT_AFFECTED';
  }
  return 'AFFECTED';
}
