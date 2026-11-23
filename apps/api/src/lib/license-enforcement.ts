import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { preHandlerHookHandler } from 'fastify';
import { Prisma } from '@prisma/client';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { forbidden } from './errors.js';
import {
  LICENSE_TIME_STATE_KEY,
  LSE_PRODUCT_ID,
  getLocalLicenseFingerprints,
  isLicenseEnvelopeV2,
  parsePublicKeyRing,
  verifyLicense,
  verifyLicenseV2,
  verifyRevocationList,
  getMachineFingerprint,
  type LicenseEnvelopeV2,
  type LicenseFile,
  type LicenseRevocationSnapshot,
  type LicenseTimeState,
  type RevocationListEnvelope,
} from './license.js';

const LICENSE_DEPLOYMENT_ID_KEY = 'license.deploymentId';
const LICENSE_INSTALL_AT_KEY = 'license.installAt';

export type LicensedFeature =
  | 'agent_audit'
  | 'content_retention'
  | 'ide_proxy'
  | 'sensitive_data_guard'
  | 'web_ai';

export interface ActiveLicenseState {
  enforced: boolean;
  valid: boolean;
  status: 'ACTIVE' | 'TRIAL' | 'EXPIRED' | 'INVALID' | 'REVOKED';
  reason?: string;
  payload?: LicenseEnvelopeV2['payload'];
  envelope?: LicenseEnvelopeV2;
  timeState?: LicenseTimeState;
}

const TRIAL_WINDOW_DAYS = 90;

const ALL_LICENSED_FEATURES: LicensedFeature[] = [
  'agent_audit',
  'content_retention',
  'ide_proxy',
  'sensitive_data_guard',
  'web_ai',
];

// 零签名试用态的合成 payload：字段齐全到能通过 assertLicensedFeature / assertUserLimitAllows
// 与 tsc 的 LicenseEnvelopeV2['payload'] 类型校验。features 含全部功能位，maxUsers=0 表示不限制。
function trialPayload(expiresAt: Date): LicenseEnvelopeV2['payload'] {
  const nowIso = new Date().toISOString();
  return {
    schemaVersion: 'license.v2',
    licenseId: 'trial-unsigned',
    customer: { id: 'trial', displayName: '试用' },
    subject: { displayName: '零签名试用', products: [LSE_PRODUCT_ID] },
    edition: 'trial',
    issuedAt: nowIso,
    notBefore: nowIso,
    expiresAt: expiresAt.toISOString(),
    maxUsers: 0,
    features: [...ALL_LICENSED_FEATURES],
    deploymentBinding: { mode: 'none' },
    gracePolicy: {
      expiryGraceDays: 0,
      clockRollbackGraceHours: 0,
      offlineRevocationStaleDays: 0,
    },
    revocationInfo: { mode: 'none' },
    issuer: 'unsigned-trial',
  };
}

export interface RuntimeLicenseVerificationContext {
  now?: Date;
  publicKey: string;
  publicKeys: Record<string, string>;
  deploymentId: string | null;
  timeState: LicenseTimeState | null;
  revocation: LicenseRevocationSnapshot | null;
}

export interface LicenseStatusResponse {
  configured: boolean;
  enforce: boolean;
  publicKeyConfigured: boolean;
  publicKeyRingConfigured: boolean;
  license: null | {
    subject: string | null;
    status: string;
    valid: boolean;
    reason?: string;
    issuedAt?: Date | string | null;
    expiresAt?: Date | string | null;
    edition?: string | null;
    maxUsers?: number | null;
    createdAt?: Date | string | null;
    [key: string]: unknown;
  };
}

export function isLicenseEnforced(): boolean {
  return config.LICENSE_ENFORCE;
}

export function requireLicensedFeature(feature: LicensedFeature): preHandlerHookHandler {
  return async () => {
    await assertLicensedFeature(feature);
  };
}

export async function assertLicensedFeature(feature: LicensedFeature): Promise<ActiveLicenseState> {
  const state = await getActiveLicenseState();
  if (!state.enforced) return state;
  if (!state.valid || !state.payload) {
    throw forbidden(`授权不可用：${state.reason ?? '未导入有效 license'}`, 'LICENSE_REQUIRED');
  }
  if (!state.payload.features.includes(feature)) {
    throw forbidden(`当前 license 未授权功能：${feature}`, 'LICENSE_FEATURE_REQUIRED');
  }
  return state;
}

export async function assertUserLimitAllows(nextActiveCount: number): Promise<void> {
  const state = await getActiveLicenseState();
  if (!state.enforced || !state.valid || !state.payload) return;
  const maxUsers = state.payload.maxUsers;
  if (maxUsers > 0 && nextActiveCount > maxUsers) {
    throw forbidden(`当前 license 最多允许 ${maxUsers} 个启用用户`, 'LICENSE_MAX_USERS_EXCEEDED');
  }
}

export async function getActiveLicenseState(
  now = new Date(),
  opts?: { forceEnforced?: boolean },
): Promise<ActiveLicenseState> {
  // forceEnforced 仅用于测试注入（在 LICENSE_ENFORCE=false 下也能走到 enforce 分支），
  // 不传时行为与生产一致。
  const enforced = opts?.forceEnforced || isLicenseEnforced();
  if (!enforced) {
    return { enforced: false, valid: true, status: 'ACTIVE' };
  }
  const row = await prisma.license.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: 'desc' },
  });
  if (!row) {
    const installAt = await readInstallAt();
    if (installAt) {
      const end = new Date(installAt.getTime() + TRIAL_WINDOW_DAYS * 86400000);
      if (now <= end) {
        return {
          enforced: true,
          valid: true,
          status: 'TRIAL',
          payload: trialPayload(end),
          reason: `试用期剩余 ${Math.ceil((end.getTime() - now.getTime()) / 86400000)} 天`,
        };
      }
      return {
        enforced: true,
        valid: false,
        status: 'EXPIRED',
        reason: '试用已到期，请导入正式授权',
      };
    }
    return { enforced: true, valid: false, status: 'INVALID', reason: '未导入 license' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.raw) as unknown;
  } catch {
    return { enforced: true, valid: false, status: 'INVALID', reason: 'license JSON 无法解析' };
  }

  const timeState = await readTimeState();
  const deploymentId = await readDeploymentId();
  const revocation = await readRevocationSnapshot();
  const parsedV2 = isLicenseEnvelopeV2(parsed) ? parsed : null;
  const result = await verifyStoredLicenseForRuntime(parsed as LicenseFile | LicenseEnvelopeV2, {
    now,
    publicKey: config.LICENSE_PUBLIC_KEY,
    publicKeys: publicKeyRing(parsedV2?.keyId ?? 'default'),
    deploymentId,
    timeState,
    revocation,
  });

  const resultTimeState = 'timeState' in result ? result.timeState : undefined;
  if (resultTimeState) await persistTimeState(resultTimeState);
  if (row.status !== result.status) {
    await prisma.license.update({ where: { id: row.id }, data: { status: result.status } });
  }
  const v2Payload = parsedV2 && 'envelope' in result ? result.payload : undefined;
  return {
    enforced: true,
    valid: result.valid,
    status: result.status,
    reason: result.valid ? undefined : result.reason,
    payload: v2Payload,
    envelope: parsedV2 && 'envelope' in result ? result.envelope : undefined,
    timeState: resultTimeState,
  };
}

export async function verifyStoredLicenseForRuntime(
  parsed: LicenseFile | LicenseEnvelopeV2,
  ctx: RuntimeLicenseVerificationContext,
) {
  const now = ctx.now ?? new Date();
  if (!isLicenseEnvelopeV2(parsed)) {
    return verifyLicense(parsed, ctx.publicKey, {
      now,
      machineFingerprint: getMachineFingerprint(),
    });
  }
  return verifyLicenseV2(parsed, {
    now,
    product: LSE_PRODUCT_ID,
    publicKeys: ctx.publicKeys,
    localFingerprints: getLocalLicenseFingerprints({ deploymentId: ctx.deploymentId }),
    timeState: ctx.timeState,
    revocation: ctx.revocation,
  });
}

export async function currentLicenseVerificationContext(fallbackKeyId: string) {
  const deploymentId = await readDeploymentId();
  return {
    publicKeys: publicKeyRing(fallbackKeyId),
    localFingerprints: getLocalLicenseFingerprints({ deploymentId }),
    timeState: await readTimeState(),
    revocation: await readRevocationSnapshot(),
  };
}

function publicKeyRing(fallbackKeyId: string): Record<string, string> {
  return {
    ...parsePublicKeyRing(config.LICENSE_PUBLIC_KEY, fallbackKeyId),
    ...parsePublicKeyRing(config.LICENSE_PUBLIC_KEYS, fallbackKeyId),
  };
}

async function readTimeState(): Promise<LicenseTimeState | null> {
  const row = await prisma.systemSetting.findUnique({ where: { key: LICENSE_TIME_STATE_KEY } });
  return isRecord(row?.value) ? (row.value as unknown as LicenseTimeState) : null;
}

async function persistTimeState(state: LicenseTimeState): Promise<void> {
  const value = state as unknown as Prisma.InputJsonValue;
  await prisma.systemSetting.upsert({
    where: { key: LICENSE_TIME_STATE_KEY },
    update: { value },
    create: { key: LICENSE_TIME_STATE_KEY, value },
  });
}

export async function readInstallAt(): Promise<Date | null> {
  const row = await prisma.systemSetting.findUnique({ where: { key: LICENSE_INSTALL_AT_KEY } });
  const value = typeof row?.value === 'string' ? row.value : null;
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function ensureInstallSeed(now: Date = new Date()): Promise<void> {
  const existing = await prisma.systemSetting.findUnique({
    where: { key: LICENSE_INSTALL_AT_KEY },
  });
  if (!existing) {
    await prisma.systemSetting.create({
      data: { key: LICENSE_INSTALL_AT_KEY, value: now.toISOString() },
    });
  }
  // 仅当 env 未提供 deploymentId 且 DB 无记录时才生成落库，避免覆盖 env 配置
  if (!config.LICENSE_DEPLOYMENT_ID.trim()) {
    const dep = await prisma.systemSetting.findUnique({
      where: { key: LICENSE_DEPLOYMENT_ID_KEY },
    });
    if (!dep) {
      await prisma.systemSetting.create({
        data: { key: LICENSE_DEPLOYMENT_ID_KEY, value: `dep_${randomUUID()}` },
      });
    }
  }
}

export async function readDeploymentId(): Promise<string | null> {
  if (config.LICENSE_DEPLOYMENT_ID.trim()) return config.LICENSE_DEPLOYMENT_ID.trim();
  const row = await prisma.systemSetting.findUnique({ where: { key: LICENSE_DEPLOYMENT_ID_KEY } });
  const value = row?.value;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function readRevocationSnapshot(): Promise<LicenseRevocationSnapshot | null> {
  const path = config.LICENSE_REVOCATION_FILE.trim();
  if (!path) return null;
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as RevocationListEnvelope;
    return verifyRevocationList(parsed, publicKeyRing(parsed.keyId));
  } catch {
    return null;
  }
}

export function sanitizeLicenseStatusResponse(input: LicenseStatusResponse): LicenseStatusResponse {
  const license = input.license
    ? {
        subject: input.license.subject,
        status: input.license.status,
        valid: input.license.valid,
        reason: input.license.reason,
        issuedAt: input.license.issuedAt,
        expiresAt: input.license.expiresAt,
        edition: input.license.edition,
        maxUsers: input.license.maxUsers,
        createdAt: input.license.createdAt,
      }
    : null;
  return {
    configured: input.configured,
    enforce: input.enforce,
    publicKeyConfigured: input.publicKeyConfigured,
    publicKeyRingConfigured: input.publicKeyRingConfigured,
    license,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
