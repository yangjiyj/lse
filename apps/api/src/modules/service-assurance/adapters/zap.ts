import { createHash } from 'node:crypto';
import { executionRecordSchema } from './nuclei.js';
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
export const ZAP_ACTIVE_RULE_IDS = ['6', '40012', '40018'] as const;

export interface ZapRulesetBaseline {
  version: string;
  digest: string;
}

export interface ZapScanRequest {
  schemaVersion: 1;
  mode: Exclude<ServiceAssuranceMode, 'SBOM'>;
  targetKind: 'OPENAPI';
  target: {
    url: string;
    hostname: string;
    pinnedAddress: string;
    allowedAddresses: string[];
  };
  budget: typeof SERVICE_ASSURANCE_REQUEST_BUDGET;
  ruleset: ZapRulesetBaseline;
  authorization: {
    activeVerification: boolean;
    auditDigest: string | null;
  };
  policy: {
    format: 'openapi';
    safeMode: boolean;
    activeRuleIds: string[];
  };
}

export function buildZapScanRequest(input: {
  mode: ServiceAssuranceMode;
  targetKind: ServiceAssuranceTargetKind;
  authorizationConfirmed: boolean;
  target: ResolvedScannerTarget;
  ruleset: ZapRulesetBaseline;
}): ZapScanRequest {
  if (input.mode === 'SBOM' || input.targetKind !== 'OPENAPI') {
    throw new Error('API 安全核验只接受 OpenAPI 目标');
  }
  if (
    !input.ruleset.version.trim() ||
    !digestSchema.safeParse(input.ruleset.digest).success ||
    (input.mode === 'DEEP' && !input.authorizationConfirmed)
  ) {
    throw new Error('深度核验授权或规则基线无效');
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
    targetKind: 'OPENAPI',
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
    policy: {
      format: 'openapi',
      safeMode: !activeVerification,
      activeRuleIds: activeVerification ? [...ZAP_ACTIVE_RULE_IDS] : [],
    },
  };
}

const responseSchema = z
  .object({
    schemaVersion: z.literal(1),
    completed: z.boolean(),
    execution: executionRecordSchema.optional(),
    outputJson: z.string().max(16 * 1024 * 1024),
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

export type ZapScanResponse = z.infer<typeof responseSchema>;

export function parseZapScanResponse(value: unknown): ZapScanResponse {
  return responseSchema.parse(value);
}

export async function executeZapScan(
  request: ZapScanRequest,
  options: {
    baseUrl: string;
    expectedEngineDigest: string;
    timeoutMs?: number;
    fetchImpl?: ScannerJsonRequestOptions['fetchImpl'];
  },
): Promise<ZapScanResponse> {
  const value = await requestScannerJson({
    baseUrl: options.baseUrl,
    path: '/v1/zap/scan',
    method: 'POST',
    body: request,
    timeoutMs: options.timeoutMs ?? SERVICE_ASSURANCE_REQUEST_BUDGET.totalTimeoutMs + 5_000,
    maxResponseBytes: 16 * 1024 * 1024,
    fetchImpl: options.fetchImpl,
  });
  let response: ZapScanResponse;
  try {
    response = parseZapScanResponse(value);
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
