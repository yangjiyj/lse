import { createHash } from 'node:crypto';
import type { AssuranceEvidenceLevel, AssurancePriority, Severity } from '@lse/shared';
import { satisfies, valid, validRange } from 'semver';
import { isRecord } from '../../../lib/redact.js';
import type {
  NucleiNormalizationResult,
  ServiceComponentDraft,
  ServiceEvidenceDraft,
  VulnerabilityAssessmentDraft,
} from '../contracts.js';
import { trivyAdvisoryRecordDigest, type TrivyAdvisoryRecord } from '../adapters/trivy.js';
import type { ParsedSbom, ParsedSbomComponent } from '../sbom.js';
import { classifyVersionAgainstFix } from '../version-range.js';

export interface TrivyNormalizationOptions {
  completed: boolean;
  vulnerabilityDbStatus: 'CURRENT' | 'STALE' | 'NOT_READY';
  vulnerabilityDbVersion: string;
  vulnerabilityDbDigest: string;
  advisoryQueryCompleted: boolean;
  advisoryRecords: TrivyAdvisoryRecord[];
  advisoryRecordsSha256: string;
}

interface TrivyVulnerability {
  advisoryId: string;
  packageName: string;
  purl: string | null;
  installedVersion: string | null;
  fixedVersions: string | null;
  title: string;
  severity: Severity | null;
  cvss: number | null;
}

interface TrivyPackage {
  packageName: string;
  purl: string;
  installedVersion: string;
}

const ADVISORY_QUERY_ECOSYSTEMS = new Set(['cargo', 'composer', 'golang', 'maven', 'npm', 'nuget']);

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function evidenceDigest(parts: string[]): string {
  return `sha256:${hash(parts.join('\u0000'))}`;
}

function stableKey(parts: Array<string | null>): string {
  return hash(parts.map((part) => part ?? '').join('\u0000'));
}

function text(value: unknown, maximum = 4_000): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeSeverity(value: unknown): Severity | null {
  const normalized = text(value, 30)?.toUpperCase();
  if (
    normalized === 'INFO' ||
    normalized === 'LOW' ||
    normalized === 'MEDIUM' ||
    normalized === 'HIGH' ||
    normalized === 'CRITICAL'
  ) {
    return normalized;
  }
  return null;
}

function priorityFor(severity: Severity | null, exact: boolean): AssurancePriority {
  if (!exact || severity === null) return 'UNKNOWN';
  if (severity === 'CRITICAL') return 'P0';
  if (severity === 'HIGH') return 'P1';
  if (severity === 'MEDIUM') return 'P2';
  return 'P3';
}

function cvssScore(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const scores: number[] = [];
  for (const source of Object.values(value)) {
    if (!isRecord(source)) continue;
    for (const field of ['V4Score', 'V3Score', 'V2Score']) {
      const score = numberValue(source[field]);
      if (score !== null && score >= 0 && score <= 10) scores.push(score);
    }
  }
  return scores.length > 0 ? Math.max(...scores) : null;
}

function parseVulnerability(value: unknown): TrivyVulnerability | null {
  if (!isRecord(value)) return null;
  const advisoryId = text(value.VulnerabilityID, 200);
  const packageName = text(value.PkgName, 500);
  if (!advisoryId || !packageName) return null;
  const identifier = isRecord(value.PkgIdentifier) ? value.PkgIdentifier : {};
  return {
    advisoryId,
    packageName,
    purl: text(identifier.PURL, 2_048),
    installedVersion: text(value.InstalledVersion, 500),
    fixedVersions: text(value.FixedVersion, 2_000),
    title: text(value.Title, 2_000) ?? advisoryId,
    severity: normalizeSeverity(value.Severity),
    cvss: cvssScore(value.CVSS),
  };
}

function parseTrivyPackage(value: unknown): TrivyPackage | null {
  if (!isRecord(value)) return null;
  const identifier = isRecord(value.Identifier) ? value.Identifier : {};
  const packageName = text(value.Name, 500);
  const purl = text(identifier.PURL, 2_048);
  const installedVersion = text(value.Version, 500);
  if (!packageName || !purl || !installedVersion) return null;
  return { packageName, purl, installedVersion };
}

function purlPackageIdentity(value: string | null): string | null {
  if (!value?.startsWith('pkg:')) return null;
  const withoutSuffix = value.split(/[?#]/, 1)[0]!;
  const slash = withoutSuffix.indexOf('/');
  if (slash < 5) return null;
  const at = withoutSuffix.lastIndexOf('@');
  return (at > slash ? withoutSuffix.slice(0, at) : withoutSuffix).toLowerCase();
}

function componentMatchesPackage(
  component: ParsedSbomComponent,
  packageName: string,
  purl: string | null,
): boolean {
  const expectedPurl = purlPackageIdentity(purl);
  const componentPurl = purlPackageIdentity(component.purl);
  if (expectedPurl && componentPurl && expectedPurl === componentPurl) return true;
  const expectedName = packageName.toLowerCase();
  const packageOnly = component.packageName.toLowerCase();
  const declared = component.name.toLowerCase();
  return (
    expectedName === packageOnly ||
    expectedName === declared ||
    expectedName.endsWith(`:${packageOnly}`) ||
    expectedName.endsWith(`/${packageOnly}`)
  );
}

function findComponent(
  sbom: ParsedSbom,
  packageName: string,
  purl: string | null,
): ParsedSbomComponent | null {
  return (
    sbom.components.find((component) => componentMatchesPackage(component, packageName, purl)) ??
    null
  );
}

function findExactScannedComponent(
  sbom: ParsedSbom,
  scannedPackage: TrivyPackage,
): ParsedSbomComponent | null {
  const component = findComponent(sbom, scannedPackage.packageName, scannedPackage.purl);
  if (
    !component ||
    component.identityStatus !== 'EXACT' ||
    !component.ecosystem ||
    !ADVISORY_QUERY_ECOSYSTEMS.has(component.ecosystem) ||
    component.version !== scannedPackage.installedVersion ||
    purlPackageIdentity(component.purl) !== purlPackageIdentity(scannedPackage.purl)
  ) {
    return null;
  }
  return component;
}

function componentKey(sbom: ParsedSbom, component: ParsedSbomComponent): string {
  return stableKey([
    sbom.contentSha256,
    component.purl,
    component.cpe,
    component.packageName,
    component.version,
  ]);
}

function componentDraft(
  sbom: ParsedSbom,
  assetKey: string,
  component: ParsedSbomComponent,
): ServiceComponentDraft {
  const exact = component.identityStatus === 'EXACT';
  return {
    assetKey,
    name: component.name,
    vendor: component.vendor,
    version: component.version,
    purl: component.purl,
    cpe: component.cpe,
    hashes: component.hashes,
    source: 'SBOM',
    confidence: exact ? 0.95 : 0.35,
    evidenceLevel: exact ? 'VERSION_MATCH' : 'LEAD',
    componentKey: componentKey(sbom, component),
  };
}

function assessmentEvidence(input: {
  assessment: VulnerabilityAssessmentDraft;
  component: ParsedSbomComponent;
  rawIdentity: Record<string, unknown>;
  sourceTool?: string;
}): ServiceEvidenceDraft {
  const exact = input.assessment.evidenceLevel === 'VERSION_MATCH';
  return {
    assessmentKey: input.assessment.assessmentKey,
    componentKey: input.assessment.componentKey,
    evidenceType: exact ? 'VERSION_MATCH' : 'COMPONENT_LEAD',
    sourceTool: input.sourceTool ?? 'trivy',
    ruleId: exact ? input.assessment.advisoryId : null,
    ruleSummary: exact ? input.assessment.title : null,
    matchedLocation: exact ? input.component.purl : null,
    extractedValue: exact ? input.component.version : null,
    customerSummary: input.assessment.reason,
    requestSummary: null,
    responseSummary: null,
    contentSha256: hash(JSON.stringify(input.rawIdentity)),
    visibility: 'TECHNICAL',
  };
}

function affectedAssessment(
  sbom: ParsedSbom,
  component: ParsedSbomComponent,
  vulnerability: TrivyVulnerability,
): VulnerabilityAssessmentDraft {
  const exact =
    component.identityStatus === 'EXACT' &&
    component.version !== null &&
    vulnerability.installedVersion !== null &&
    component.version === vulnerability.installedVersion &&
    purlPackageIdentity(component.purl) === purlPackageIdentity(vulnerability.purl);
  const evidenceLevel: AssuranceEvidenceLevel = exact ? 'VERSION_MATCH' : 'LEAD';
  const advisoryId = exact ? vulnerability.advisoryId : null;
  const title = exact ? `${component.name} 版本受已知漏洞影响` : '疑似组件、待核验线索';
  const reason = exact
    ? `组件 ${component.name} ${component.version} 与 ${vulnerability.advisoryId} 受影响版本精确匹配。`
    : '仅识别到组件名称或不完整身份，未取得可信版本证据，当前不能确认对应漏洞影响。';
  return {
    assetKey: stableKey([sbom.contentSha256, 'sbom-asset']),
    componentKey: componentKey(sbom, component),
    advisoryId,
    title,
    severity: exact ? vulnerability.severity : null,
    cvss: exact ? vulnerability.cvss : null,
    fixedVersion: exact ? vulnerability.fixedVersions : null,
    kev: null,
    epss: null,
    impactStatus: exact ? 'AFFECTED' : 'UNDER_INVESTIGATION',
    evidenceLevel,
    confidence: exact ? 0.95 : 0.35,
    priority: priorityFor(vulnerability.severity, exact),
    reason,
    remediation:
      exact && vulnerability.fixedVersions
        ? `升级到适用的修复版本：${vulnerability.fixedVersions}。`
        : null,
    assessmentKey: stableKey([
      sbom.contentSha256,
      componentKey(sbom, component),
      advisoryId,
      evidenceLevel,
    ]),
  };
}

function normalizeAdvisoryRange(ecosystem: string | null, range: string): string {
  const normalized = range.replaceAll(',', ' ');
  if (ecosystem !== 'maven') return normalized;
  return normalized
    .split(/\s+/)
    .map((token) =>
      token.replace(/^([<>]=?|=)?(\d+)\.(\d+)-([0-9A-Za-z][0-9A-Za-z.-]*)$/, '$1$2.$3.0-$4'),
    )
    .join(' ');
}

function advisoryRangeMatches(
  ecosystem: string | null,
  version: string,
  range: string,
): boolean | null {
  if (!valid(version, { loose: false })) return null;
  const normalized = validRange(normalizeAdvisoryRange(ecosystem, range), {
    includePrerelease: true,
    loose: false,
  });
  if (!normalized) return null;
  return satisfies(version, normalized, { includePrerelease: true, loose: false });
}

function classifyAdvisoryRecord(
  component: ParsedSbomComponent,
  record: TrivyAdvisoryRecord,
): 'AFFECTED' | 'NOT_AFFECTED' | 'UNKNOWN' {
  if (
    component.identityStatus !== 'EXACT' ||
    !component.version ||
    component.version !== record.installedVersion ||
    component.ecosystem !== record.ecosystem ||
    component.purl !== record.purl
  ) {
    return 'UNKNOWN';
  }

  const vulnerableMatches = record.vulnerableVersions.map((range) =>
    advisoryRangeMatches(component.ecosystem, component.version!, range),
  );
  if (vulnerableMatches.includes(true)) return 'AFFECTED';
  if (vulnerableMatches.includes(null)) return 'UNKNOWN';
  if (record.vulnerableVersions.length > 0) return 'NOT_AFFECTED';

  const unaffectedMatches = record.unaffectedVersions.map((range) =>
    advisoryRangeMatches(component.ecosystem, component.version!, range),
  );
  if (unaffectedMatches.includes(true)) return 'NOT_AFFECTED';
  if (unaffectedMatches.includes(null)) return 'UNKNOWN';

  if (record.patchedVersions.length === 0) return 'UNKNOWN';
  return classifyVersionAgainstFix({
    ecosystem: component.ecosystem,
    installedVersion: component.version,
    fixedVersions: record.patchedVersions.join(','),
  });
}

function validAdvisoryEnvelope(options: TrivyNormalizationOptions): boolean {
  if (
    !options.advisoryQueryCompleted ||
    typeof options.vulnerabilityDbVersion !== 'string' ||
    options.vulnerabilityDbVersion.trim().length === 0 ||
    typeof options.vulnerabilityDbDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(options.vulnerabilityDbDigest) ||
    !Array.isArray(options.advisoryRecords) ||
    typeof options.advisoryRecordsSha256 !== 'string'
  ) {
    return false;
  }

  let previousKey: string | null = null;
  const recordDigests: string[] = [];
  for (const record of options.advisoryRecords) {
    if (
      !record ||
      typeof record.ecosystem !== 'string' ||
      !ADVISORY_QUERY_ECOSYSTEMS.has(record.ecosystem) ||
      typeof record.packageName !== 'string' ||
      typeof record.purl !== 'string' ||
      typeof record.installedVersion !== 'string' ||
      typeof record.advisoryId !== 'string' ||
      !Array.isArray(record.vulnerableVersions) ||
      !Array.isArray(record.patchedVersions) ||
      !Array.isArray(record.unaffectedVersions) ||
      typeof record.recordSha256 !== 'string'
    ) {
      return false;
    }
    const { recordSha256, ...content } = record;
    if (trivyAdvisoryRecordDigest(content, options.vulnerabilityDbDigest) !== recordSha256) {
      return false;
    }
    const key = `${record.purl}\u0000${record.installedVersion}\u0000${record.advisoryId}`;
    if (previousKey !== null && key <= previousKey) return false;
    previousKey = key;
    recordDigests.push(recordSha256);
  }
  return evidenceDigest(recordDigests) === options.advisoryRecordsSha256;
}

function advisoryMatchesObservation(
  record: TrivyAdvisoryRecord,
  observation: { component: ParsedSbomComponent; scannedPackage: TrivyPackage },
): boolean {
  return (
    record.ecosystem === observation.component.ecosystem &&
    record.packageName === observation.scannedPackage.packageName &&
    record.purl === observation.scannedPackage.purl &&
    record.installedVersion === observation.scannedPackage.installedVersion &&
    record.purl === observation.component.purl &&
    record.installedVersion === observation.component.version
  );
}

function notAffectedAssessment(
  sbom: ParsedSbom,
  component: ParsedSbomComponent,
  record: TrivyAdvisoryRecord,
  options: Pick<TrivyNormalizationOptions, 'vulnerabilityDbStatus'>,
): VulnerabilityAssessmentDraft {
  const fixedVersions = [...record.patchedVersions].sort().join(', ');
  const reason =
    options.vulnerabilityDbStatus === 'STALE'
      ? `组件 ${component.name} ${component.version} 不在 ${record.advisoryId} 公告列明的受影响范围；该判断仅针对固定漏洞库基线中的具体公告，漏洞库已过期，整体覆盖仍不完整。`
      : `组件 ${component.name} ${component.version} 不在 ${record.advisoryId} 公告列明的受影响范围；该判断绑定本次基线与公告记录。`;
  return {
    assetKey: stableKey([sbom.contentSha256, 'sbom-asset']),
    componentKey: componentKey(sbom, component),
    advisoryId: record.advisoryId,
    title: `${component.name} 当前版本不受该漏洞影响`,
    severity: null,
    cvss: null,
    fixedVersion: fixedVersions || null,
    kev: null,
    epss: null,
    impactStatus: 'NOT_AFFECTED',
    evidenceLevel: 'VERSION_MATCH',
    confidence: 0.95,
    priority: 'UNKNOWN',
    reason,
    remediation: null,
    assessmentKey: stableKey([
      sbom.contentSha256,
      componentKey(sbom, component),
      record.advisoryId,
      'VERSION_MATCH',
    ]),
  };
}

function componentLeadAssessment(
  sbom: ParsedSbom,
  component: ParsedSbomComponent,
): VulnerabilityAssessmentDraft {
  const reason =
    component.identityStatus === 'MISSING_VERSION'
      ? `组件清单中的 ${component.name} 缺少可信版本，当前不能判断漏洞影响。`
      : component.identityStatus === 'INVALID_PURL'
        ? `组件清单中的 ${component.name} 包标识无效，当前不能判断漏洞影响。`
        : `组件清单中的 ${component.name} 只有名称线索，当前不能判断漏洞影响。`;
  return {
    assetKey: stableKey([sbom.contentSha256, 'sbom-asset']),
    componentKey: componentKey(sbom, component),
    advisoryId: null,
    title: '疑似组件、待核验线索',
    severity: null,
    cvss: null,
    fixedVersion: null,
    kev: null,
    epss: null,
    impactStatus: 'UNDER_INVESTIGATION',
    evidenceLevel: 'LEAD',
    confidence: 0.35,
    priority: 'UNKNOWN',
    reason,
    remediation: null,
    assessmentKey: stableKey([
      sbom.contentSha256,
      componentKey(sbom, component),
      'sbom-identity-lead',
    ]),
  };
}

function exactComponentLeadAssessment(
  sbom: ParsedSbom,
  component: ParsedSbomComponent,
  reason: string,
): VulnerabilityAssessmentDraft {
  return {
    assetKey: stableKey([sbom.contentSha256, 'sbom-asset']),
    componentKey: componentKey(sbom, component),
    advisoryId: null,
    title: '疑似组件、待核验线索',
    severity: null,
    cvss: null,
    fixedVersion: null,
    kev: null,
    epss: null,
    impactStatus: 'UNDER_INVESTIGATION',
    evidenceLevel: 'LEAD',
    confidence: 0.55,
    priority: 'UNKNOWN',
    reason,
    remediation: null,
    assessmentKey: stableKey([
      sbom.contentSha256,
      componentKey(sbom, component),
      'advisory-coverage-lead',
    ]),
  };
}

export function normalizeTrivyJson(
  rawJson: string,
  sbom: ParsedSbom,
  options: TrivyNormalizationOptions,
): NucleiNormalizationResult {
  let document: unknown;
  try {
    document = JSON.parse(rawJson);
  } catch {
    throw new Error('组件漏洞核验结果格式无效');
  }
  if (
    !isRecord(document) ||
    document.SchemaVersion !== 2 ||
    (document.Results !== undefined && !Array.isArray(document.Results))
  ) {
    throw new Error('组件漏洞核验结果格式无效');
  }
  const results = Array.isArray(document.Results) ? document.Results : [];

  const assetKey = stableKey([sbom.contentSha256, 'sbom-asset']);
  const assets = [
    {
      customerName: '组件清单',
      normalizedAddress: '组件清单',
      protocol: null,
      host: null,
      port: null,
      title: null,
      assetKey,
    },
  ];
  const components = sbom.components.map((component) => componentDraft(sbom, assetKey, component));
  const assessments: VulnerabilityAssessmentDraft[] = [];
  const evidence: ServiceEvidenceDraft[] = [];
  const observedPackages = new Map<
    string,
    { component: ParsedSbomComponent; scannedPackage: TrivyPackage }
  >();
  const negativeEvidenceBlockedComponentKeys = new Set<string>();
  const rawOutputSha256 = hash(rawJson);
  let invalidLineCount = 0;
  let vulnerabilityCount = 0;

  for (const result of results) {
    if (!isRecord(result)) {
      invalidLineCount += 1;
      continue;
    }
    const resultObservedComponentKeys = new Set<string>();
    let resultOutputInvalid = false;
    if (
      result.Packages !== undefined &&
      result.Packages !== null &&
      !Array.isArray(result.Packages)
    ) {
      invalidLineCount += 1;
      resultOutputInvalid = true;
    }
    const packages = Array.isArray(result.Packages) ? result.Packages : [];
    for (const rawPackage of packages) {
      const scannedPackage = parseTrivyPackage(rawPackage);
      if (!scannedPackage) {
        invalidLineCount += 1;
        resultOutputInvalid = true;
        continue;
      }
      const component = findExactScannedComponent(sbom, scannedPackage);
      if (!component) continue;
      const key = componentKey(sbom, component);
      observedPackages.set(key, { component, scannedPackage });
      resultObservedComponentKeys.add(key);
    }
    if (
      result.Vulnerabilities !== undefined &&
      result.Vulnerabilities !== null &&
      !Array.isArray(result.Vulnerabilities)
    ) {
      invalidLineCount += 1;
      resultOutputInvalid = true;
    }
    const vulnerabilities = Array.isArray(result.Vulnerabilities) ? result.Vulnerabilities : [];
    for (const rawVulnerability of vulnerabilities) {
      const vulnerability = parseVulnerability(rawVulnerability);
      if (!vulnerability) {
        invalidLineCount += 1;
        resultOutputInvalid = true;
        continue;
      }
      vulnerabilityCount += 1;
      const component = findComponent(sbom, vulnerability.packageName, vulnerability.purl);
      if (!component) continue;
      const assessment = affectedAssessment(sbom, component, vulnerability);
      assessments.push(assessment);
      evidence.push(
        assessmentEvidence({
          assessment,
          component,
          rawIdentity: {
            advisoryId: vulnerability.advisoryId,
            purl: vulnerability.purl,
            installedVersion: vulnerability.installedVersion,
            fixedVersions: vulnerability.fixedVersions,
          },
        }),
      );
    }
    if (resultOutputInvalid) {
      for (const key of resultObservedComponentKeys) {
        negativeEvidenceBlockedComponentKeys.add(key);
      }
    }
  }

  const assessedComponentKeys = new Set(
    assessments.flatMap((assessment) =>
      assessment.componentKey === null ? [] : [assessment.componentKey],
    ),
  );
  const advisoryEnvelopeIsValid = validAdvisoryEnvelope(options);
  const negativeEvidenceReady =
    options.completed && options.vulnerabilityDbStatus !== 'NOT_READY' && advisoryEnvelopeIsValid;
  let advisoryCoverageIncomplete =
    options.completed && options.vulnerabilityDbStatus === 'CURRENT' && !advisoryEnvelopeIsValid;

  if (negativeEvidenceReady) {
    for (const record of options.advisoryRecords) {
      const observation = [...observedPackages.values()].find((candidate) =>
        advisoryMatchesObservation(record, candidate),
      );
      if (!observation) {
        advisoryCoverageIncomplete = true;
        continue;
      }
      const key = componentKey(sbom, observation.component);
      if (negativeEvidenceBlockedComponentKeys.has(key)) {
        advisoryCoverageIncomplete = true;
        continue;
      }
      const duplicate = assessments.some(
        (assessment) =>
          assessment.componentKey === key && assessment.advisoryId === record.advisoryId,
      );
      if (duplicate) continue;

      if (classifyAdvisoryRecord(observation.component, record) !== 'NOT_AFFECTED') {
        advisoryCoverageIncomplete = true;
        continue;
      }
      const assessment = notAffectedAssessment(sbom, observation.component, record, options);
      assessments.push(assessment);
      assessedComponentKeys.add(key);
      evidence.push(
        assessmentEvidence({
          assessment,
          component: observation.component,
          rawIdentity: {
            rawOutputSha256,
            advisoryRecordSha256: record.recordSha256,
            advisoryRecordsSha256: options.advisoryRecordsSha256,
            vulnerabilityDbVersion: options.vulnerabilityDbVersion,
            vulnerabilityDbDigest: options.vulnerabilityDbDigest,
            advisoryId: record.advisoryId,
            purl: record.purl,
            installedVersion: record.installedVersion,
            vulnerableVersions: record.vulnerableVersions,
            patchedVersions: record.patchedVersions,
            unaffectedVersions: record.unaffectedVersions,
          },
        }),
      );
    }
  }

  for (const component of sbom.components) {
    const key = componentKey(sbom, component);
    if (component.identityStatus === 'EXACT' || assessedComponentKeys.has(key)) continue;
    const assessment = componentLeadAssessment(sbom, component);
    assessments.push(assessment);
    assessedComponentKeys.add(key);
    evidence.push(
      assessmentEvidence({
        assessment,
        component,
        sourceTool: 'sbom',
        rawIdentity: {
          name: component.name,
          purl: component.purl,
          version: component.version,
          identityStatus: component.identityStatus,
        },
      }),
    );
  }

  for (const component of sbom.components) {
    const key = componentKey(sbom, component);
    if (component.identityStatus !== 'EXACT' || assessedComponentKeys.has(key)) continue;
    const observation = observedPackages.get(key);
    const matchingRecords = Array.isArray(options.advisoryRecords)
      ? options.advisoryRecords.filter(
          (record) => observation && advisoryMatchesObservation(record, observation),
        )
      : [];
    const reason = !observation
      ? `本次核验输出未观察到组件 ${component.name} ${component.version}，当前不能判断漏洞影响。`
      : !negativeEvidenceReady
        ? `组件 ${component.name} ${component.version} 的公告核验未完整执行，当前不能形成不受影响结论。`
        : matchingRecords.length === 0
          ? `组件 ${component.name} ${component.version} 未取得可审计的具体公告范围，当前不能形成不受影响结论。`
          : `组件 ${component.name} ${component.version} 的公告版本范围无法可靠判断，当前保持待核验。`;
    const assessment = exactComponentLeadAssessment(sbom, component, reason);
    assessments.push(assessment);
    assessedComponentKeys.add(key);
    advisoryCoverageIncomplete = true;
    evidence.push(
      assessmentEvidence({
        assessment,
        component,
        rawIdentity: {
          rawOutputSha256,
          purl: component.purl,
          installedVersion: component.version,
          observed: Boolean(observation),
          advisoryQueryCompleted: options.advisoryQueryCompleted,
        },
      }),
    );
  }

  const notices: Array<{ code: string; message: string }> = [];
  if (invalidLineCount > 0) {
    notices.push({
      code: 'SERVICE_ASSURANCE_OUTPUT_PARTIAL',
      message: '部分组件核验结果无法解析，本次覆盖不完整。',
    });
  }
  if (advisoryCoverageIncomplete) {
    notices.push({
      code: 'SERVICE_ASSURANCE_ADVISORY_COVERAGE_INCOMPLETE',
      message: '组件公告核验未完整执行，本次覆盖不完整。',
    });
  }
  if (!options.completed) {
    notices.push({
      code: 'SERVICE_ASSURANCE_SCAN_INCOMPLETE',
      message: '核验未完整执行，结论仅适用于已完成检查项。',
    });
  }
  if (options.vulnerabilityDbStatus === 'STALE') {
    notices.push({
      code: 'SERVICE_ASSURANCE_VULNDB_STALE',
      message: '漏洞库已过期，本次覆盖不完整。',
    });
  }
  if (options.vulnerabilityDbStatus === 'NOT_READY') {
    notices.push({
      code: 'SERVICE_ASSURANCE_VULNDB_NOT_READY',
      message: '组件清单核验模式尚未就绪。',
    });
  }

  const coverageStatus =
    options.vulnerabilityDbStatus === 'NOT_READY'
      ? 'NOT_READY'
      : notices.length > 0
        ? 'INCOMPLETE'
        : 'COMPLETE';
  const count = (status: VulnerabilityAssessmentDraft['impactStatus']): number =>
    assessments.filter((assessment) => assessment.impactStatus === status).length;

  return {
    mode: 'SBOM',
    coverageStatus,
    invalidLineCount,
    eventsProcessed: Math.max(components.length, vulnerabilityCount, assessments.length),
    assets,
    components,
    assessments,
    evidence,
    notices,
    customerSummary: {
      confirmed: count('AFFECTED'),
      underInvestigation: count('UNDER_INVESTIGATION'),
      notAffected: count('NOT_AFFECTED'),
      fixed: count('FIXED'),
      incomplete: coverageStatus !== 'COMPLETE',
      statusMessage:
        coverageStatus === 'COMPLETE'
          ? '核验已完成。'
          : coverageStatus === 'NOT_READY'
            ? '当前模式尚未就绪。'
            : '核验未完成或覆盖不完整。',
    },
  };
}
