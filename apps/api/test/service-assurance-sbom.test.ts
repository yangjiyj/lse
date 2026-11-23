import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  parseSbomUpload,
  SERVICE_ASSURANCE_SBOM_LIMITS,
  SbomInputError,
} from '../src/modules/service-assurance/sbom.js';
import { classifyVersionAgainstFix } from '../src/modules/service-assurance/version-range.js';

const fixtureUrl = (name: string) =>
  new URL(`./fixtures/service-assurance/${name}`, import.meta.url);

async function fixture(name: string): Promise<string> {
  return readFile(fixtureUrl(name), 'utf8');
}

function assertSbomError(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof SbomInputError && error.code === code);
}

test('CycloneDX JSON 只提取标准组件身份并计算内容摘要', async () => {
  const content = await fixture('cyclonedx-triton-affected.json');
  const parsed = parseSbomUpload({
    contentType: 'application/vnd.cyclonedx+json',
    content,
  });

  assert.equal(parsed.format, 'CYCLONEDX_JSON');
  assert.match(parsed.contentSha256, /^[a-f0-9]{64}$/);
  assert.equal(parsed.components.length, 2);
  assert.deepEqual(
    parsed.components.map(({ name, version, ecosystem, identityStatus }) => ({
      name,
      version,
      ecosystem,
      identityStatus,
    })),
    [
      {
        name: 'NVIDIA Triton 推理服务',
        version: '2.40.0',
        ecosystem: 'generic',
        identityStatus: 'EXACT',
      },
      {
        name: 'log4j-core',
        version: '2.14.1',
        ecosystem: 'maven',
        identityStatus: 'EXACT',
      },
    ],
  );
  assert.equal(parsed.components[1]?.cpe, 'cpe:2.3:a:apache:log4j:2.14.1:*:*:*:*:*:*:*');
  assert.deepEqual(parsed.components[1]?.hashes, {
    SHA256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  });
  assert.doesNotMatch(JSON.stringify(parsed), /serialNumber|documentNamespace|raw/i);
});

test('SPDX JSON 和 SPDX tag-value 使用同一客户组件契约', async () => {
  const json = parseSbomUpload({
    contentType: 'application/spdx+json; charset=utf-8',
    content: await fixture('spdx-triton-affected.json'),
  });
  assert.equal(json.format, 'SPDX_JSON');
  assert.equal(json.components.length, 2);
  assert.equal(json.components[1]?.purl, 'pkg:maven/org.apache.logging.log4j/log4j-core@2.14.1');

  const tagValue = parseSbomUpload({
    contentType: 'text/spdx',
    content: [
      'SPDXVersion: SPDX-2.3',
      'DataLicense: CC0-1.0',
      'SPDXID: SPDXRef-DOCUMENT',
      'DocumentName: triton-service',
      'DocumentNamespace: https://lse.invalid/spdx/tag-value/20260830',
      'Creator: Tool: LSE fixture',
      'Created: 2026-08-30T00:00:00Z',
      '',
      'PackageName: org.apache.logging.log4j:log4j-core',
      'SPDXID: SPDXRef-Log4j',
      'PackageVersion: 2.14.1',
      'PackageSupplier: Organization: Apache Software Foundation',
      'PackageDownloadLocation: NOASSERTION',
      'FilesAnalyzed: false',
      'PackageChecksum: SHA256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'ExternalRef: PACKAGE-MANAGER purl pkg:maven/org.apache.logging.log4j/log4j-core@2.14.1',
      'ExternalRef: SECURITY cpe23Type cpe:2.3:a:apache:log4j:2.14.1:*:*:*:*:*:*:*',
      '',
    ].join('\n'),
  });
  assert.equal(tagValue.format, 'SPDX_TAG_VALUE');
  assert.equal(tagValue.components.length, 1);
  assert.equal(tagValue.components[0]?.identityStatus, 'EXACT');
});

test('缺版本与错误 purl 保持待核验身份，不能伪造成精确组件', async () => {
  const parsed = parseSbomUpload({
    contentType: 'application/vnd.cyclonedx+json',
    content: await fixture('cyclonedx-missing-version.json'),
  });

  assert.equal(parsed.components[0]?.identityStatus, 'MISSING_VERSION');
  assert.equal(parsed.components[1]?.identityStatus, 'INVALID_PURL');
  assert.equal(parsed.components[1]?.purl, null);
});

test('SBOM 边界拒绝错误类型、路径、压缩包、二进制、超限和深层嵌套', () => {
  const minimal = JSON.stringify({
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    components: [],
  });
  assertSbomError(
    () => parseSbomUpload({ contentType: 'application/octet-stream', content: minimal }),
    'SERVICE_ASSURANCE_SBOM_CONTENT_TYPE',
  );
  assertSbomError(
    () =>
      parseSbomUpload({
        contentType: 'application/vnd.cyclonedx+json',
        content: minimal,
        path: '../../etc/passwd',
      } as never),
    'SERVICE_ASSURANCE_SBOM_REQUEST_INVALID',
  );
  assertSbomError(
    () =>
      parseSbomUpload({
        contentType: 'application/vnd.cyclonedx+json',
        content: Uint8Array.from([0x50, 0x4b, 0x03, 0x04]),
      }),
    'SERVICE_ASSURANCE_SBOM_ARCHIVE_REJECTED',
  );
  assertSbomError(
    () =>
      parseSbomUpload({
        contentType: 'application/vnd.cyclonedx+json',
        content: Uint8Array.from([0xff, 0x00, 0x01]),
      }),
    'SERVICE_ASSURANCE_SBOM_BINARY_REJECTED',
  );
  assertSbomError(
    () =>
      parseSbomUpload({
        contentType: 'application/vnd.cyclonedx+json',
        content: 'x'.repeat(SERVICE_ASSURANCE_SBOM_LIMITS.maxBytes + 1),
      }),
    'SERVICE_ASSURANCE_SBOM_TOO_LARGE',
  );

  const deep = JSON.stringify({
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    components: [
      {
        type: 'library',
        name: 'deep',
        version: '1.0.0',
        nested: Array.from({ length: SERVICE_ASSURANCE_SBOM_LIMITS.maxDepth + 1 }).reduce(
          (value) => [value],
          'end' as unknown,
        ),
      },
    ],
  });
  assertSbomError(
    () =>
      parseSbomUpload({
        contentType: 'application/vnd.cyclonedx+json',
        content: deep,
      }),
    'SERVICE_ASSURANCE_SBOM_TOO_DEEP',
  );

  const tooMany = JSON.stringify({
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    components: Array.from(
      { length: SERVICE_ASSURANCE_SBOM_LIMITS.maxComponents + 1 },
      (_, index) => ({ type: 'library', name: `component-${index}`, version: '1.0.0' }),
    ),
  });
  assertSbomError(
    () =>
      parseSbomUpload({
        contentType: 'application/vnd.cyclonedx+json',
        content: tooMany,
      }),
    'SERVICE_ASSURANCE_SBOM_COMPONENT_LIMIT',
  );
});

test('版本判断按生态版本分支区分受影响、修复与无法判断', () => {
  const log4jFixes = '2.15.0, 2.3.1, 2.12.2';
  assert.equal(
    classifyVersionAgainstFix({
      ecosystem: 'maven',
      installedVersion: '2.14.1',
      fixedVersions: log4jFixes,
    }),
    'AFFECTED',
  );
  assert.equal(
    classifyVersionAgainstFix({
      ecosystem: 'maven',
      installedVersion: '2.12.2',
      fixedVersions: log4jFixes,
    }),
    'NOT_AFFECTED',
  );
  assert.equal(
    classifyVersionAgainstFix({
      ecosystem: 'maven',
      installedVersion: '2.25.4',
      fixedVersions: log4jFixes,
    }),
    'NOT_AFFECTED',
  );
  assert.equal(
    classifyVersionAgainstFix({
      ecosystem: 'deb',
      installedVersion: '1:2.14.1-1',
      fixedVersions: '1:2.15.0-1',
    }),
    'UNKNOWN',
  );
  assert.equal(
    classifyVersionAgainstFix({
      ecosystem: 'maven',
      installedVersion: 'not-a-version',
      fixedVersions: '2.15.0',
    }),
    'UNKNOWN',
  );
});
