import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { toFormalFindingDraft } from '../src/modules/service-assurance/decision.js';
import {
  buildTrivyScanRequest,
  parseTrivyScanResponse,
} from '../src/modules/service-assurance/adapters/trivy.js';
import { normalizeTrivyJson } from '../src/modules/service-assurance/normalize/trivy.js';
import { parseSbomUpload } from '../src/modules/service-assurance/sbom.js';

const fixtureUrl = (name: string) =>
  new URL(`./fixtures/service-assurance/${name}`, import.meta.url);

async function fixture(name: string): Promise<string> {
  return readFile(fixtureUrl(name), 'utf8');
}

async function mavenOnlyFixture(name: string): Promise<string> {
  const document = JSON.parse(await fixture(name)) as {
    metadata?: { component?: unknown };
  };
  if (document.metadata) delete document.metadata.component;
  return JSON.stringify(document);
}

const VULNERABILITY_DB_VERSION = 'trivy-db-2026.08.30T070529Z';
const VULNERABILITY_DB_DIGEST = `sha256:${'a'.repeat(64)}`;

function evidenceDigest(parts: string[]): string {
  return `sha256:${createHash('sha256').update(parts.join('\u0000')).digest('hex')}`;
}

function advisoryEvidence(
  recordWithoutDigest: {
    ecosystem: string;
    packageName: string;
    purl: string;
    installedVersion: string;
    advisoryId: string;
    vulnerableVersions: string[];
    patchedVersions: string[];
    unaffectedVersions: string[];
  },
  databaseDigest = VULNERABILITY_DB_DIGEST,
) {
  const recordSha256 = evidenceDigest([
    databaseDigest,
    recordWithoutDigest.ecosystem,
    recordWithoutDigest.packageName,
    recordWithoutDigest.purl,
    recordWithoutDigest.installedVersion,
    recordWithoutDigest.advisoryId,
    recordWithoutDigest.vulnerableVersions.join('\n'),
    recordWithoutDigest.patchedVersions.join('\n'),
    recordWithoutDigest.unaffectedVersions.join('\n'),
  ]);
  return {
    vulnerabilityDbVersion: VULNERABILITY_DB_VERSION,
    vulnerabilityDbDigest: databaseDigest,
    advisoryQueryCompleted: true,
    advisoryRecords: [{ ...recordWithoutDigest, recordSha256 }],
    advisoryRecordsSha256: evidenceDigest([recordSha256]),
  };
}

function fixedAdvisoryEvidence(databaseDigest = VULNERABILITY_DB_DIGEST) {
  return advisoryEvidence(
    {
      ecosystem: 'maven',
      packageName: 'org.apache.logging.log4j:log4j-core',
      purl: 'pkg:maven/org.apache.logging.log4j/log4j-core@2.25.4',
      installedVersion: '2.25.4',
      advisoryId: 'CVE-2021-44228',
      vulnerableVersions: ['>=2.13.0, <2.15.0', '>=2.4, <2.12.2'],
      patchedVersions: ['2.15.0', '2.12.2'],
      unaffectedVersions: [] as string[],
    },
    databaseDigest,
  );
}

test('Trivy 请求只携带已解析清单、内容摘要和固定离线基线', async () => {
  const content = await fixture('cyclonedx-triton-affected.json');
  const parsed = parseSbomUpload({
    contentType: 'application/vnd.cyclonedx+json',
    content,
  });
  const request = buildTrivyScanRequest({
    sbom: parsed,
    content,
    vulnerabilityDb: {
      version: 'trivy-db-2026.05.22',
      digest: `sha256:${'a'.repeat(64)}`,
    },
  });

  assert.equal(request.schemaVersion, 1);
  assert.equal(request.sbom.contentSha256, parsed.contentSha256);
  assert.equal(request.sbom.format, 'CYCLONEDX_JSON');
  assert.equal(request.sbom.content, content);
  assert.deepEqual(request.policy, {
    offline: true,
    skipDbUpdate: true,
    skipJavaDbUpdate: true,
    skipVexRepoUpdate: true,
    disableTelemetry: true,
    detectionPriority: 'precise',
  });
  assert.doesNotMatch(JSON.stringify(request), /command|templatePath|timeout|concurrency|path/i);
});

test('Trivy sidecar 响应拒绝未知字段并锁定漏洞库与引擎摘要', () => {
  const valid = {
    schemaVersion: 1,
    completed: true,
    outputJson: '{"SchemaVersion":2,"Results":[]}',
    durationMs: 25,
    vulnerabilityDbVersion: 'trivy-db-2026.05.22',
    vulnerabilityDbDigest: `sha256:${'a'.repeat(64)}`,
    vulnerabilityDbUpdatedAt: '2026-05-22T19:06:39.311Z',
    vulnerabilityDbStatus: 'CURRENT',
    engineVersion: '0.70.0',
    engineDigest: `sha256:${'b'.repeat(64)}`,
    errorCode: null,
    errorMessage: null,
  };
  const withAdvisories = { ...valid, ...fixedAdvisoryEvidence(valid.vulnerabilityDbDigest) };
  assert.equal(parseTrivyScanResponse(withAdvisories).completed, true);
  assert.equal(
    parseTrivyScanResponse(withAdvisories).advisoryRecords[0]?.advisoryId,
    'CVE-2021-44228',
  );
  assert.throws(() =>
    parseTrivyScanResponse({
      ...withAdvisories,
      advisoryRecordsSha256: `sha256:${'f'.repeat(64)}`,
    }),
  );
  assert.throws(() => parseTrivyScanResponse({ ...valid, stderr: '/internal/path' }));
});

test('真实 Trivy 受影响输出形成 VERSION_MATCH，严重度与优先级分开', async () => {
  const sbom = parseSbomUpload({
    contentType: 'application/vnd.cyclonedx+json',
    content: await fixture('cyclonedx-triton-affected.json'),
  });
  const result = normalizeTrivyJson(await fixture('trivy-affected.json'), sbom, {
    completed: true,
    vulnerabilityDbStatus: 'CURRENT',
  });
  const log4shell = result.assessments.find(
    (assessment) => assessment.advisoryId === 'CVE-2021-44228',
  );

  assert.ok(log4shell);
  assert.equal(log4shell.impactStatus, 'AFFECTED');
  assert.equal(log4shell.evidenceLevel, 'VERSION_MATCH');
  assert.equal(log4shell.severity, 'CRITICAL');
  assert.equal(log4shell.priority, 'P0');
  assert.ok(toFormalFindingDraft(log4shell));
  assert.match(
    result.evidence.find((item) => item.assessmentKey === log4shell.assessmentKey)?.contentSha256 ??
      '',
    /^[a-f0-9]{64}$/,
  );
});

test('修复版本、缺版本和错误 purl 不得进入正式风险', async () => {
  const fixed = parseSbomUpload({
    contentType: 'application/vnd.cyclonedx+json',
    content: await fixture('cyclonedx-triton-fixed.json'),
  });
  const fixedResult = normalizeTrivyJson(await fixture('trivy-fixed.json'), fixed, {
    completed: true,
    vulnerabilityDbStatus: 'CURRENT',
    ...fixedAdvisoryEvidence(),
  });
  const notAffected = fixedResult.assessments.find(
    (assessment) => assessment.advisoryId === 'CVE-2021-44228',
  );
  assert.ok(notAffected);
  assert.equal(notAffected.impactStatus, 'NOT_AFFECTED');
  assert.equal(toFormalFindingDraft(notAffected), null);

  const weak = parseSbomUpload({
    contentType: 'application/vnd.cyclonedx+json',
    content: await fixture('cyclonedx-missing-version.json'),
  });
  const weakResult = normalizeTrivyJson(await fixture('trivy-affected.json'), weak, {
    completed: true,
    vulnerabilityDbStatus: 'CURRENT',
  });
  assert.ok(weakResult.assessments.length > 0);
  for (const assessment of weakResult.assessments) {
    assert.equal(assessment.impactStatus, 'UNDER_INVESTIGATION');
    assert.equal(assessment.evidenceLevel, 'LEAD');
    assert.equal(toFormalFindingDraft(assessment), null);
  }
});

test('修复版本首次扫描只按同一固定库的具体公告形成非受影响结论', async () => {
  const fixed = parseSbomUpload({
    contentType: 'application/vnd.cyclonedx+json',
    content: await fixture('cyclonedx-triton-fixed.json'),
  });
  const result = normalizeTrivyJson(await fixture('trivy-fixed.json'), fixed, {
    completed: true,
    vulnerabilityDbStatus: 'CURRENT',
    ...fixedAdvisoryEvidence(),
  });
  const baselineConclusion = result.assessments.find(
    (assessment) => assessment.advisoryId === 'CVE-2021-44228',
  );

  assert.ok(baselineConclusion);
  assert.equal(baselineConclusion.impactStatus, 'NOT_AFFECTED');
  assert.equal(baselineConclusion.evidenceLevel, 'VERSION_MATCH');
  assert.equal(baselineConclusion.severity, null);
  assert.equal(baselineConclusion.priority, 'UNKNOWN');
  assert.equal(baselineConclusion.fixedVersion, '2.12.2, 2.15.0');
  assert.match(baselineConclusion.reason, /CVE-2021-44228.*受影响范围.*本次基线/);
  assert.equal(toFormalFindingDraft(baselineConclusion), null);
});

test('完整受影响范围不命中时不得被未来修复版本反向判为受影响', async () => {
  const sbom = parseSbomUpload({
    contentType: 'application/vnd.cyclonedx+json',
    content: await mavenOnlyFixture('cyclonedx-triton-affected.json'),
  });
  const output = (await fixture('trivy-fixed.json')).replaceAll('2.25.4', '2.14.1');
  const result = normalizeTrivyJson(output, sbom, {
    completed: true,
    vulnerabilityDbStatus: 'CURRENT',
    ...advisoryEvidence({
      ecosystem: 'maven',
      packageName: 'org.apache.logging.log4j:log4j-core',
      purl: 'pkg:maven/org.apache.logging.log4j/log4j-core@2.14.1',
      installedVersion: '2.14.1',
      advisoryId: 'CVE-2026-34478',
      vulnerableVersions: ['>=2.21.0, <2.25.4', '>=3.0.0-beta1, <=3.0.0-beta3'],
      patchedVersions: ['2.25.4'],
      unaffectedVersions: [],
    }),
  });

  assert.equal(result.coverageStatus, 'COMPLETE');
  assert.equal(result.assessments[0]?.impactStatus, 'NOT_AFFECTED');
  assert.equal(result.assessments[0]?.advisoryId, 'CVE-2026-34478');
});

test('Maven 短预发布范围在修复版本上形成精确非受影响结论', async () => {
  const sbom = parseSbomUpload({
    contentType: 'application/vnd.cyclonedx+json',
    content: await mavenOnlyFixture('cyclonedx-triton-fixed.json'),
  });
  const result = normalizeTrivyJson(await fixture('trivy-fixed.json'), sbom, {
    completed: true,
    vulnerabilityDbStatus: 'CURRENT',
    ...advisoryEvidence({
      ecosystem: 'maven',
      packageName: 'org.apache.logging.log4j:log4j-core',
      purl: 'pkg:maven/org.apache.logging.log4j/log4j-core@2.25.4',
      installedVersion: '2.25.4',
      advisoryId: 'CVE-2025-68161',
      vulnerableVersions: ['>=2.0-beta9, <2.25.3'],
      patchedVersions: ['2.25.3'],
      unaffectedVersions: [],
    }),
  });

  assert.equal(result.coverageStatus, 'COMPLETE');
  assert.equal(result.assessments[0]?.impactStatus, 'NOT_AFFECTED');
  assert.equal(result.assessments[0]?.advisoryId, 'CVE-2025-68161');
});

test('具体公告负向结论对不完整扫描、未知包和不支持生态失败关闭', async () => {
  const fixedContent = await fixture('cyclonedx-triton-fixed.json');
  const fixed = parseSbomUpload({
    contentType: 'application/vnd.cyclonedx+json',
    content: fixedContent,
  });
  const output = await fixture('trivy-fixed.json');

  const incomplete = normalizeTrivyJson(output, fixed, {
    completed: false,
    vulnerabilityDbStatus: 'CURRENT',
    ...fixedAdvisoryEvidence(),
  });
  assert.ok(
    incomplete.assessments.every((assessment) => assessment.impactStatus !== 'NOT_AFFECTED'),
  );

  const unknown = parseSbomUpload({
    contentType: 'application/vnd.cyclonedx+json',
    content: fixedContent
      .replaceAll('org.apache.logging.log4j:log4j-core', 'example.invalid:unknown')
      .replaceAll('org.apache.logging.log4j/log4j-core', 'example.invalid/unknown')
      .replaceAll('2.25.4', '9.9.9'),
  });
  const unknownOutput = output
    .replaceAll('org.apache.logging.log4j:log4j-core', 'example.invalid:unknown')
    .replaceAll('org.apache.logging.log4j/log4j-core', 'example.invalid/unknown')
    .replaceAll('2.25.4', '9.9.9');
  const unknownResult = normalizeTrivyJson(unknownOutput, unknown, {
    completed: true,
    vulnerabilityDbStatus: 'CURRENT',
    vulnerabilityDbVersion: VULNERABILITY_DB_VERSION,
    vulnerabilityDbDigest: VULNERABILITY_DB_DIGEST,
    advisoryQueryCompleted: true,
    advisoryRecords: [],
    advisoryRecordsSha256: evidenceDigest([]),
  });
  assert.ok(
    unknownResult.assessments.every((assessment) => assessment.impactStatus !== 'NOT_AFFECTED'),
  );

  const unsupported = parseSbomUpload({
    contentType: 'application/vnd.cyclonedx+json',
    content: fixedContent.replaceAll('pkg:maven/', 'pkg:unsupported/'),
  });
  const unsupportedOutput = output.replaceAll('pkg:maven/', 'pkg:unsupported/');
  const result = normalizeTrivyJson(unsupportedOutput, unsupported, {
    completed: true,
    vulnerabilityDbStatus: 'CURRENT',
    vulnerabilityDbVersion: VULNERABILITY_DB_VERSION,
    vulnerabilityDbDigest: VULNERABILITY_DB_DIGEST,
    advisoryQueryCompleted: false,
    advisoryRecords: [],
    advisoryRecordsSha256: evidenceDigest([]),
  });
  assert.ok(result.assessments.every((assessment) => assessment.impactStatus !== 'NOT_AFFECTED'));
  assert.equal(result.coverageStatus, 'INCOMPLETE');
  assert.ok(
    result.assessments.some((assessment) => assessment.impactStatus === 'UNDER_INVESTIGATION'),
  );

  const unobserved = normalizeTrivyJson(
    JSON.stringify({ SchemaVersion: 2, Trivy: { Version: '0.70.0' } }),
    fixed,
    {
      completed: true,
      vulnerabilityDbStatus: 'CURRENT',
      vulnerabilityDbVersion: VULNERABILITY_DB_VERSION,
      vulnerabilityDbDigest: VULNERABILITY_DB_DIGEST,
      advisoryQueryCompleted: true,
      advisoryRecords: [],
      advisoryRecordsSha256: evidenceDigest([]),
    },
  );
  assert.ok(
    unobserved.assessments.every((assessment) => assessment.impactStatus !== 'NOT_AFFECTED'),
  );
  assert.equal(unobserved.coverageStatus, 'INCOMPLETE');
  assert.ok(
    unobserved.assessments.some((assessment) => assessment.impactStatus === 'UNDER_INVESTIGATION'),
  );
});

test('过期固定库只形成公告级负向结论且整体覆盖保持不完整', async () => {
  const fixed = parseSbomUpload({
    contentType: 'application/vnd.cyclonedx+json',
    content: await fixture('cyclonedx-triton-fixed.json'),
  });
  const result = normalizeTrivyJson(await fixture('trivy-fixed.json'), fixed, {
    completed: true,
    vulnerabilityDbStatus: 'STALE',
    ...fixedAdvisoryEvidence(),
  });
  const conclusion = result.assessments.find(
    (assessment) => assessment.advisoryId === 'CVE-2021-44228',
  );

  assert.equal(result.coverageStatus, 'INCOMPLETE');
  assert.equal(result.customerSummary.incomplete, true);
  assert.ok(result.notices.some((notice) => notice.code === 'SERVICE_ASSURANCE_VULNDB_STALE'));
  assert.ok(conclusion);
  assert.equal(conclusion.impactStatus, 'NOT_AFFECTED');
  assert.equal(conclusion.evidenceLevel, 'VERSION_MATCH');
  assert.match(conclusion.reason, /固定漏洞库.*已过期.*整体覆盖仍不完整/);
});

test('非法漏洞集合不得借合法 Packages 形成负向结论', async () => {
  const fixed = parseSbomUpload({
    contentType: 'application/vnd.cyclonedx+json',
    content: await fixture('cyclonedx-triton-fixed.json'),
  });
  const malformed = JSON.parse(await fixture('trivy-fixed.json')) as {
    Results: Array<Record<string, unknown>>;
  };
  malformed.Results[0]!.Vulnerabilities = {};
  const result = normalizeTrivyJson(JSON.stringify(malformed), fixed, {
    completed: true,
    vulnerabilityDbStatus: 'CURRENT',
    ...fixedAdvisoryEvidence(),
  });

  assert.equal(result.coverageStatus, 'INCOMPLETE');
  assert.ok(result.invalidLineCount > 0);
  assert.ok(result.assessments.every((assessment) => assessment.impactStatus !== 'NOT_AFFECTED'));
});

test('无关结果损坏时保留已完整核验组件的负向结论并标记覆盖不完整', async () => {
  const fixed = parseSbomUpload({
    contentType: 'application/vnd.cyclonedx+json',
    content: await fixture('cyclonedx-triton-fixed.json'),
  });
  const partial = JSON.parse(await fixture('trivy-fixed.json')) as {
    Results: Array<Record<string, unknown>>;
  };
  partial.Results.push({
    Target: 'unrelated-invalid-result',
    Class: 'lang-pkgs',
    Type: 'npm',
    Packages: {},
    Vulnerabilities: [],
  });

  const result = normalizeTrivyJson(JSON.stringify(partial), fixed, {
    completed: true,
    vulnerabilityDbStatus: 'CURRENT',
    ...fixedAdvisoryEvidence(),
  });
  const conclusion = result.assessments.find(
    (assessment) => assessment.advisoryId === 'CVE-2021-44228',
  );

  assert.equal(result.coverageStatus, 'INCOMPLETE');
  assert.ok(result.invalidLineCount > 0);
  assert.ok(conclusion);
  assert.equal(conclusion.impactStatus, 'NOT_AFFECTED');
  assert.equal(conclusion.evidenceLevel, 'VERSION_MATCH');
  assert.match(conclusion.reason, /CVE-2021-44228.*受影响范围.*本次基线/);
  assert.match(
    result.evidence.find((item) => item.assessmentKey === conclusion.assessmentKey)
      ?.contentSha256 ?? '',
    /^[a-f0-9]{64}$/,
  );
});

test('负向证据哈希同时绑定扫描输出、公告记录和漏洞库摘要', async () => {
  const fixed = parseSbomUpload({
    contentType: 'application/vnd.cyclonedx+json',
    content: await fixture('cyclonedx-triton-fixed.json'),
  });
  const output = await fixture('trivy-fixed.json');
  const normalize = (rawJson: string, databaseDigest = VULNERABILITY_DB_DIGEST) =>
    normalizeTrivyJson(rawJson, fixed, {
      completed: true,
      vulnerabilityDbStatus: 'CURRENT',
      ...fixedAdvisoryEvidence(databaseDigest),
    });
  const contentHash = (result: ReturnType<typeof normalizeTrivyJson>) => {
    const assessment = result.assessments.find((item) => item.advisoryId === 'CVE-2021-44228');
    assert.ok(assessment);
    const evidence = result.evidence.find(
      (item) => item.assessmentKey === assessment.assessmentKey,
    );
    assert.ok(evidence);
    return evidence.contentSha256;
  };

  const changedEnvelope = JSON.parse(output) as Record<string, unknown>;
  changedEnvelope.CreatedAt = '2026-08-30T14:16:32.00000000+08:00';
  const first = contentHash(normalize(output));
  const second = contentHash(normalize(JSON.stringify(changedEnvelope)));
  const third = contentHash(normalize(output, `sha256:${'b'.repeat(64)}`));

  assert.notEqual(first, second);
  assert.notEqual(first, third);
});

test('真实空 Trivy 报告保留缺版本和错误 purl 线索', async () => {
  const weak = parseSbomUpload({
    contentType: 'application/vnd.cyclonedx+json',
    content: await fixture('cyclonedx-missing-version.json'),
  });
  const result = normalizeTrivyJson(
    JSON.stringify({ SchemaVersion: 2, Trivy: { Version: '0.70.0' } }),
    weak,
    {
      completed: true,
      vulnerabilityDbStatus: 'CURRENT',
    },
  );

  assert.equal(result.customerSummary.confirmed, 0);
  assert.ok(result.customerSummary.underInvestigation >= 1);
  assert.ok(
    result.assessments.every((assessment) => assessment.impactStatus === 'UNDER_INVESTIGATION'),
  );
  assert.ok(result.assessments.every((assessment) => assessment.evidenceLevel === 'LEAD'));
  assert.ok(result.assessments.every((assessment) => toFormalFindingDraft(assessment) === null));
});

test('过期漏洞库、部分输出和未知严重度必须如实降级覆盖', async () => {
  const sbom = parseSbomUpload({
    contentType: 'application/vnd.cyclonedx+json',
    content: await fixture('cyclonedx-triton-affected.json'),
  });
  const raw = JSON.parse(await fixture('trivy-affected.json')) as {
    Results: Array<{ Vulnerabilities?: Array<Record<string, unknown>> }>;
  };
  const first = raw.Results[0]?.Vulnerabilities?.[0];
  assert.ok(first);
  first.Severity = 'UNKNOWN';

  const stale = normalizeTrivyJson(JSON.stringify(raw), sbom, {
    completed: false,
    vulnerabilityDbStatus: 'STALE',
  });
  assert.equal(stale.coverageStatus, 'INCOMPLETE');
  assert.equal(stale.assessments[0]?.severity, null);
  assert.equal(stale.assessments[0]?.priority, 'UNKNOWN');
  assert.ok(stale.notices.some((notice) => notice.code === 'SERVICE_ASSURANCE_VULNDB_STALE'));
  assert.ok(stale.notices.some((notice) => notice.code === 'SERVICE_ASSURANCE_SCAN_INCOMPLETE'));
});
