import type { ServiceAssuranceMode, ServiceAssuranceReadinessResponse } from '@lse/shared';
import { requestScannerJson } from './adapters/client.js';

interface ModeReadinessInput {
  enabled: boolean;
  healthy: boolean;
  baselineUpdatedAt: string | null;
  maxBaselineAgeDays?: number;
}

export interface ServiceAssuranceReadinessInput {
  now?: Date;
  safe: ModeReadinessInput;
  deep: ModeReadinessInput;
  sbom: ModeReadinessInput;
}

const MODE_LABEL: Record<ServiceAssuranceMode, string> = {
  SAFE: '安全检查',
  DEEP: '授权深度核验',
  SBOM: '组件清单核验',
};

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

interface RuntimeScannerConfig {
  url: string;
  engineDigest: string;
  baselineVersion: string;
  baselineDigest: string;
  baselineUpdatedAt: string;
}

function validScannerConfig(config: RuntimeScannerConfig): boolean {
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    return false;
  }
  return (
    ['http:', 'https:'].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    DIGEST_PATTERN.test(config.engineDigest) &&
    !!config.baselineVersion.trim() &&
    DIGEST_PATTERN.test(config.baselineDigest) &&
    normalizedDate(config.baselineUpdatedAt) !== null
  );
}

async function scannerHealthy(url: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const response = await requestScannerJson({
      baseUrl: url,
      path: '/healthz',
      method: 'GET',
      timeoutMs: 2_000,
      maxResponseBytes: 4 * 1024,
      fetchImpl,
    });
    return (
      typeof response === 'object' &&
      response !== null &&
      !Array.isArray(response) &&
      (response as Record<string, unknown>).status === 'ok' &&
      (response as Record<string, unknown>).ready === true
    );
  } catch {
    return false;
  }
}

function oldestBaselineDate(left: string, right: string): string {
  return new Date(left).getTime() <= new Date(right).getTime() ? left : right;
}

function normalizedDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** 基线日期的展示形式：YYYY-MM-DD（UTC），取不到时说明未记录。 */
function baselineDateText(value: string | null): string {
  const iso = normalizedDate(value);
  return iso ? iso.slice(0, 10) : '未记录';
}

function isBaselineStale(input: ModeReadinessInput, now: Date): boolean {
  const updatedAt = normalizedDate(input.baselineUpdatedAt);
  if (!updatedAt || input.maxBaselineAgeDays === undefined) return false;
  return now.getTime() - new Date(updatedAt).getTime() > input.maxBaselineAgeDays * 86_400_000;
}

function modeReadiness(
  mode: ServiceAssuranceMode,
  input: ModeReadinessInput,
  now: Date,
): ServiceAssuranceReadinessResponse['modes'][number] {
  const label = MODE_LABEL[mode];
  const ready = input.enabled && input.healthy;
  const stale = ready && isBaselineStale(input, now);
  const message = !input.enabled
    ? `${label}尚未启用。`
    : !input.healthy
      ? `${label}尚未就绪。`
      : stale
        ? `${label}可用，但规则或漏洞库基线已过期（最近一次更新：${baselineDateText(input.baselineUpdatedAt)}），本次覆盖不完整。请通过离线更新包更新规则与漏洞库，或联系供应商。`
        : `${label}已就绪。`;
  return {
    mode,
    ready,
    message,
    baselineUpdatedAt: normalizedDate(input.baselineUpdatedAt),
  };
}

export function buildServiceAssuranceReadiness(
  input: ServiceAssuranceReadinessInput,
): ServiceAssuranceReadinessResponse {
  const now = input.now ?? new Date();
  return {
    modes: [
      modeReadiness('SAFE', input.safe, now),
      modeReadiness('DEEP', input.deep, now),
      modeReadiness('SBOM', input.sbom, now),
    ],
  };
}

export async function probeServiceAssuranceReadiness(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<ServiceAssuranceReadinessResponse> {
  const nuclei = {
    url: env.SERVICE_ASSURANCE_NUCLEI_URL?.trim() ?? '',
    engineDigest: env.SERVICE_ASSURANCE_NUCLEI_ENGINE_DIGEST?.trim() ?? '',
    baselineVersion: env.SERVICE_ASSURANCE_NUCLEI_RULESET_VERSION?.trim() ?? '',
    baselineDigest: env.SERVICE_ASSURANCE_NUCLEI_RULESET_DIGEST?.trim() ?? '',
    baselineUpdatedAt: env.SERVICE_ASSURANCE_NUCLEI_RULESET_UPDATED_AT?.trim() ?? '',
  };
  const zap = {
    url: env.SERVICE_ASSURANCE_ZAP_URL?.trim() ?? '',
    engineDigest: env.SERVICE_ASSURANCE_ZAP_ENGINE_DIGEST?.trim() ?? '',
    baselineVersion: env.SERVICE_ASSURANCE_ZAP_RULESET_VERSION?.trim() ?? nuclei.baselineVersion,
    baselineDigest: env.SERVICE_ASSURANCE_ZAP_RULESET_DIGEST?.trim() ?? nuclei.baselineDigest,
    baselineUpdatedAt:
      env.SERVICE_ASSURANCE_ZAP_RULESET_UPDATED_AT?.trim() ?? nuclei.baselineUpdatedAt,
  };
  const trivy = {
    url: env.SERVICE_ASSURANCE_TRIVY_URL?.trim() ?? '',
    engineDigest: env.SERVICE_ASSURANCE_TRIVY_ENGINE_DIGEST?.trim() ?? '',
    baselineVersion: env.SERVICE_ASSURANCE_TRIVY_DB_VERSION?.trim() ?? '',
    baselineDigest: env.SERVICE_ASSURANCE_TRIVY_DB_DIGEST?.trim() ?? '',
    baselineUpdatedAt: env.SERVICE_ASSURANCE_TRIVY_DB_UPDATED_AT?.trim() ?? '',
  };
  const nucleiEnabled = validScannerConfig(nuclei);
  const zapEnabled = validScannerConfig(zap);
  const trivyEnabled = validScannerConfig(trivy);
  const [nucleiHealthy, zapHealthy, trivyHealthy] = await Promise.all([
    nucleiEnabled ? scannerHealthy(nuclei.url, fetchImpl) : false,
    zapEnabled ? scannerHealthy(zap.url, fetchImpl) : false,
    trivyEnabled ? scannerHealthy(trivy.url, fetchImpl) : false,
  ]);

  const endpoint = {
    enabled: nucleiEnabled,
    healthy: nucleiHealthy,
    baselineUpdatedAt: nucleiEnabled ? nuclei.baselineUpdatedAt : null,
    maxBaselineAgeDays: 30,
  };
  const openapi = {
    enabled: nucleiEnabled && zapEnabled,
    healthy:
      nucleiHealthy &&
      zapHealthy &&
      nuclei.baselineVersion === zap.baselineVersion &&
      nuclei.baselineDigest === zap.baselineDigest,
    baselineUpdatedAt:
      nucleiEnabled && zapEnabled
        ? oldestBaselineDate(nuclei.baselineUpdatedAt, zap.baselineUpdatedAt)
        : null,
    maxBaselineAgeDays: 30,
  };
  const result = buildServiceAssuranceReadiness({
    now,
    safe: endpoint,
    deep: endpoint,
    sbom: {
      enabled: trivyEnabled,
      healthy: trivyHealthy,
      baselineUpdatedAt: trivyEnabled ? trivy.baselineUpdatedAt : null,
      maxBaselineAgeDays: 30,
    },
  });
  return {
    ...result,
    targets: [
      ...(['SAFE', 'DEEP'] as const).flatMap((mode) => [
        { ...modeReadiness(mode, endpoint, now), targetKind: 'ENDPOINT' as const },
        { ...modeReadiness(mode, openapi, now), targetKind: 'OPENAPI' as const },
        {
          ...modeReadiness(mode, endpoint, now),
          targetKind: 'MCP' as const,
          ready: false,
          message: '当前未提供 MCP 协议及工具行为专项检查。',
        },
      ]),
      { ...result.modes.find((item) => item.mode === 'SBOM')!, targetKind: 'SBOM' as const },
    ],
  };
}
