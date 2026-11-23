import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SERVICE_ASSURANCE_SBOM_LIMITS, type ParsedSbom } from '../sbom.js';
import {
  requestScannerJson,
  ScannerClientError,
  type ScannerJsonRequestOptions,
} from './client.js';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const advisoryRecordSchema = z
  .object({
    ecosystem: z.string().trim().min(1).max(50),
    packageName: z.string().trim().min(1).max(500),
    purl: z.string().trim().startsWith('pkg:').max(2_048),
    installedVersion: z.string().trim().min(1).max(500),
    advisoryId: z.string().trim().min(3).max(200),
    vulnerableVersions: z.array(z.string().trim().min(1).max(2_000)).max(100),
    patchedVersions: z.array(z.string().trim().min(1).max(2_000)).max(100),
    unaffectedVersions: z.array(z.string().trim().min(1).max(2_000)).max(100),
    recordSha256: digestSchema,
  })
  .strict();

export type TrivyAdvisoryRecord = z.infer<typeof advisoryRecordSchema>;

function evidenceDigest(parts: string[]): string {
  return `sha256:${createHash('sha256').update(parts.join('\u0000')).digest('hex')}`;
}

export function trivyAdvisoryRecordDigest(
  record: Omit<TrivyAdvisoryRecord, 'recordSha256'>,
  vulnerabilityDbDigest: string,
): string {
  return evidenceDigest([
    vulnerabilityDbDigest,
    record.ecosystem,
    record.packageName,
    record.purl,
    record.installedVersion,
    record.advisoryId,
    record.vulnerableVersions.join('\n'),
    record.patchedVersions.join('\n'),
    record.unaffectedVersions.join('\n'),
  ]);
}

export interface TrivyVulnerabilityDbBaseline {
  version: string;
  digest: string;
}

export interface TrivyScanRequest {
  schemaVersion: 1;
  sbom: {
    format: ParsedSbom['format'];
    contentSha256: string;
    content: string;
  };
  vulnerabilityDb: TrivyVulnerabilityDbBaseline;
  policy: {
    offline: true;
    skipDbUpdate: true;
    skipJavaDbUpdate: true;
    skipVexRepoUpdate: true;
    disableTelemetry: true;
    detectionPriority: 'precise';
  };
}

export function buildTrivyScanRequest(input: {
  sbom: ParsedSbom;
  content: string;
  vulnerabilityDb: TrivyVulnerabilityDbBaseline;
}): TrivyScanRequest {
  const bytes = Buffer.byteLength(input.content, 'utf8');
  const digest = createHash('sha256').update(input.content).digest('hex');
  if (
    bytes !== input.sbom.byteLength ||
    bytes > SERVICE_ASSURANCE_SBOM_LIMITS.maxBytes ||
    digest !== input.sbom.contentSha256 ||
    !input.vulnerabilityDb.version.trim() ||
    !digestSchema.safeParse(input.vulnerabilityDb.digest).success
  ) {
    throw new Error('组件清单或漏洞库基线不一致');
  }
  return {
    schemaVersion: 1,
    sbom: {
      format: input.sbom.format,
      contentSha256: input.sbom.contentSha256,
      content: input.content,
    },
    vulnerabilityDb: { ...input.vulnerabilityDb },
    policy: {
      offline: true,
      skipDbUpdate: true,
      skipJavaDbUpdate: true,
      skipVexRepoUpdate: true,
      disableTelemetry: true,
      detectionPriority: 'precise',
    },
  };
}

const responseSchema = z
  .object({
    schemaVersion: z.literal(1),
    completed: z.boolean(),
    outputJson: z.string().max(16 * 1024 * 1024),
    durationMs: z.number().int().nonnegative(),
    vulnerabilityDbVersion: z.string().trim().min(1).max(200),
    vulnerabilityDbDigest: digestSchema,
    vulnerabilityDbUpdatedAt: z.string().datetime(),
    vulnerabilityDbStatus: z.enum(['CURRENT', 'STALE', 'NOT_READY']),
    engineVersion: z.string().trim().min(1).max(100),
    engineDigest: digestSchema,
    advisoryQueryCompleted: z.boolean(),
    advisoryRecords: z.array(advisoryRecordSchema).max(10_000),
    advisoryRecordsSha256: digestSchema,
    errorCode: z.string().trim().min(1).max(100).nullable(),
    errorMessage: z.string().trim().min(1).max(500).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (!value.advisoryQueryCompleted && value.advisoryRecords.length > 0) ||
      (value.completed && !value.advisoryQueryCompleted)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '组件公告查询完整性与运行状态不一致',
      });
      return;
    }
    let previousKey: string | null = null;
    for (const [index, record] of value.advisoryRecords.entries()) {
      const { recordSha256, ...content } = record;
      if (trivyAdvisoryRecordDigest(content, value.vulnerabilityDbDigest) !== recordSha256) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['advisoryRecords', index, 'recordSha256'],
          message: '组件公告记录摘要不一致',
        });
      }
      const key = `${record.purl}\u0000${record.installedVersion}\u0000${record.advisoryId}`;
      if (previousKey !== null && key <= previousKey) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['advisoryRecords', index],
          message: '组件公告记录顺序或唯一性无效',
        });
      }
      previousKey = key;
    }
    if (
      evidenceDigest(value.advisoryRecords.map((record) => record.recordSha256)) !==
      value.advisoryRecordsSha256
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['advisoryRecordsSha256'],
        message: '组件公告集合摘要不一致',
      });
    }
  });

export type TrivyScanResponse = z.infer<typeof responseSchema>;

export function parseTrivyScanResponse(value: unknown): TrivyScanResponse {
  return responseSchema.parse(value);
}

export interface ExecuteTrivyScanOptions {
  baseUrl: string;
  expectedEngineDigest: string;
  timeoutMs?: number;
  fetchImpl?: ScannerJsonRequestOptions['fetchImpl'];
}

export async function executeTrivyScan(
  request: TrivyScanRequest,
  options: ExecuteTrivyScanOptions,
): Promise<TrivyScanResponse> {
  const value = await requestScannerJson({
    baseUrl: options.baseUrl,
    path: '/v1/trivy/scan',
    method: 'POST',
    body: request,
    timeoutMs: options.timeoutMs ?? 125_000,
    maxResponseBytes: 16 * 1024 * 1024,
    fetchImpl: options.fetchImpl,
  });
  let response: TrivyScanResponse;
  try {
    response = parseTrivyScanResponse(value);
  } catch {
    throw new ScannerClientError('SERVICE_ASSURANCE_SIDECAR_RESPONSE_INVALID');
  }
  if (
    response.vulnerabilityDbVersion !== request.vulnerabilityDb.version ||
    response.vulnerabilityDbDigest !== request.vulnerabilityDb.digest ||
    response.engineDigest !== options.expectedEngineDigest
  ) {
    throw new ScannerClientError('SERVICE_ASSURANCE_SIDECAR_BASELINE_MISMATCH');
  }
  return response;
}
