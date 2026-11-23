import { createHash } from 'node:crypto';
import type { ServiceAssuranceMode, ServiceAssuranceTargetKind } from '@lse/shared';
import { z } from 'zod';
import type { ResolvedScannerTarget } from '../../../lib/scanner-scope.js';
import { SERVICE_ASSURANCE_REQUEST_BUDGET } from '../contracts.js';
import {
  requestScannerJson,
  ScannerClientError,
  type ScannerJsonRequestOptions,
} from './client.js';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export interface NucleiRulesetBaseline {
  version: string;
  digest: string;
}

export interface BuildNucleiScanRequestInput {
  mode: ServiceAssuranceMode;
  targetKind: ServiceAssuranceTargetKind;
  authorizationConfirmed: boolean;
  target: ResolvedScannerTarget;
  ruleset: NucleiRulesetBaseline;
}

export interface NucleiScanRequest {
  schemaVersion: 1;
  mode: ServiceAssuranceMode;
  targetKind: Exclude<ServiceAssuranceTargetKind, 'SBOM'>;
  target: {
    url: string;
    hostname: string;
    pinnedAddress: string;
    allowedAddresses: string[];
  };
  budget: typeof SERVICE_ASSURANCE_REQUEST_BUDGET;
  ruleset: NucleiRulesetBaseline;
  authorization: {
    activeVerification: boolean;
    auditDigest: string | null;
  };
}

export function buildNucleiScanRequest(input: BuildNucleiScanRequestInput): NucleiScanRequest {
  if (input.targetKind === 'SBOM') throw new Error('Nuclei 不接受 SBOM 目标');
  if (input.mode === 'DEEP' && !input.authorizationConfirmed) {
    throw new Error('深度核验必须确认授权');
  }
  const activeVerification = input.mode === 'DEEP';
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        mode: input.mode,
        target: input.target.url.toString(),
        pinnedAddress: input.target.pinnedAddress,
        ruleset: input.ruleset,
        authorizationConfirmed: activeVerification,
      }),
    )
    .digest('hex');
  return {
    schemaVersion: 1,
    mode: input.mode,
    targetKind: input.targetKind,
    target: {
      url: input.target.url.toString(),
      hostname: input.target.hostname,
      pinnedAddress: input.target.pinnedAddress,
      allowedAddresses: [...input.target.addresses],
    },
    budget: SERVICE_ASSURANCE_REQUEST_BUDGET,
    ruleset: { ...input.ruleset },
    authorization: {
      activeVerification,
      auditDigest: activeVerification ? 'sha256:' + digest : null,
    },
  };
}

export const executionRecordSchema = z
  .object({
    checks: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(200),
            label: z.string().trim().min(1).max(200),
            status: z.enum(['COMPLETED', 'FAILED', 'SKIPPED', 'UNKNOWN']),
            requestCount: z
              .number()
              .int()
              .nonnegative()
              .max(SERVICE_ASSURANCE_REQUEST_BUDGET.maxRequests)
              .nullable(),
            detail: z.string().max(1_000),
          })
          .strict(),
      )
      .max(100),
    requestCount: z
      .number()
      .int()
      .nonnegative()
      .max(SERVICE_ASSURANCE_REQUEST_BUDGET.maxRequests)
      .nullable(),
  })
  .strict();

const responseSchema = z
  .object({
    schemaVersion: z.literal(1),
    completed: z.boolean(),
    execution: executionRecordSchema.optional(),
    outputJsonl: z.string().max(16 * 1024 * 1024),
    durationMs: z.number().int().nonnegative(),
    rulesetVersion: z.string().trim().min(1).max(200),
    rulesetDigest: digestSchema,
    rulesetUpdatedAt: z.string().datetime(),
    rulesetStatus: z.enum(['CURRENT', 'STALE', 'NOT_READY']),
    engineVersion: z.string().trim().min(1).max(100),
    engineDigest: digestSchema,
    errorCode: z.string().trim().min(1).max(100).nullable(),
    errorMessage: z.string().trim().min(1).max(500).nullable(),
  })
  .strict();

export type NucleiScanResponse = z.infer<typeof responseSchema>;

export function parseNucleiScanResponse(value: unknown): NucleiScanResponse {
  return responseSchema.parse(value);
}

export interface ExecuteNucleiScanOptions {
  baseUrl: string;
  expectedEngineDigest: string;
  timeoutMs?: number;
  fetchImpl?: ScannerJsonRequestOptions['fetchImpl'];
}

export async function executeNucleiScan(
  request: NucleiScanRequest,
  options: ExecuteNucleiScanOptions,
): Promise<NucleiScanResponse> {
  const value = await requestScannerJson({
    baseUrl: options.baseUrl,
    path: '/v1/nuclei/scan',
    method: 'POST',
    body: request,
    timeoutMs: options.timeoutMs ?? SERVICE_ASSURANCE_REQUEST_BUDGET.totalTimeoutMs + 5_000,
    maxResponseBytes: 16 * 1024 * 1024,
    fetchImpl: options.fetchImpl,
  });
  let response: NucleiScanResponse;
  try {
    response = parseNucleiScanResponse(value);
  } catch {
    throw new ScannerClientError('SERVICE_ASSURANCE_SIDECAR_RESPONSE_INVALID');
  }
  if (
    response.rulesetVersion !== request.ruleset.version ||
    response.rulesetDigest !== request.ruleset.digest ||
    response.engineDigest !== options.expectedEngineDigest
  ) {
    throw new ScannerClientError('SERVICE_ASSURANCE_SIDECAR_BASELINE_MISMATCH');
  }
  return response;
}
