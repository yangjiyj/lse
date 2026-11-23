import crypto from 'node:crypto';
import os from 'node:os';
import type { LicenseStatus } from '@lse/shared';

export const LSE_PRODUCT_ID = 'llm-safety-eval-platform';
export const LICENSE_TIME_STATE_KEY = 'license.timeState';
export const LICENSE_V2_ALGORITHM = 'Ed25519-JCS-B64URL';
export const LICENSE_V2_SCHEMA = 'license.v2';
export const REVOCATION_LIST_SCHEMA = 'license-revocation-list.v1';

export interface LicensePayload {
  subject?: string;
  issuedAt?: string;
  expiresAt?: string;
  machineFingerprint?: string;
  [key: string]: unknown;
}

export interface LicenseFile {
  payload: LicensePayload;
  signature: string;
}

export interface LicenseV2Fingerprint {
  scope: 'machine' | 'cluster' | 'deployment';
  algorithm: 'sha256';
  value: string;
}

export interface LicenseEnvelopeV2 {
  schemaVersion: 'license.v2';
  payload: {
    schemaVersion: 'license.v2';
    licenseId: string;
    customer: { id: string; displayName: string };
    subject: { displayName: string; products: string[] };
    edition: string;
    issuedAt: string;
    notBefore: string;
    expiresAt: string;
    maxUsers: number;
    features: string[];
    deploymentBinding:
      | { mode: 'none'; bindingId?: never; fingerprints?: never }
      | { mode: 'optional' | 'required'; bindingId: string; fingerprints: LicenseV2Fingerprint[] };
    gracePolicy: {
      expiryGraceDays: number;
      clockRollbackGraceHours: number;
      offlineRevocationStaleDays: number;
    };
    revocationInfo:
      | { mode: 'none'; listId?: string; url?: string }
      | { mode: 'offline-file' | 'online'; listId: string; url?: string };
    issuer: string;
  };
  signatureAlgorithm: 'Ed25519-JCS-B64URL';
  keyId: string;
  signature: string;
}

export interface RevocationListEnvelope {
  schemaVersion: 'license-revocation-list.v1';
  payload: {
    schemaVersion: 'license-revocation-list.v1';
    listId: string;
    issuer: string;
    issuedAt: string;
    validUntil: string;
    revokedLicenses: Array<{ licenseId: string; revokedAt: string; reason?: string }>;
    revokedKeyIds: string[];
  };
  signatureAlgorithm: 'Ed25519-JCS-B64URL';
  keyId: string;
  signature: string;
}

export interface LicenseTimeState {
  schemaVersion?: 'license-time-state.v1';
  licenseId?: string;
  lastSeenWallTime?: string;
  maxSeenWallTime?: string;
  firstSeenAt?: string;
  clockRollbackDetectedAt?: string | null;
}

export interface LicenseRevocationSnapshot {
  listId?: string;
  revokedLicenseIds?: readonly string[];
  revokedKeyIds?: readonly string[];
  validUntil?: string;
}

export type LicenseVerifyResult =
  | { valid: true; status: 'ACTIVE'; payload: LicensePayload; reason?: undefined }
  | { valid: false; status: LicenseStatus; payload?: LicensePayload; reason: string };

export type LicenseVerifyResultV2 =
  | {
      valid: true;
      status: 'ACTIVE';
      payload: LicenseEnvelopeV2['payload'];
      envelope: LicenseEnvelopeV2;
      effectiveNow: Date;
      timeState: LicenseTimeState;
      reason?: undefined;
    }
  | {
      valid: false;
      status: LicenseStatus;
      payload?: LicenseEnvelopeV2['payload'];
      envelope?: LicenseEnvelopeV2;
      effectiveNow?: Date;
      timeState?: LicenseTimeState;
      reason: string;
      code: string;
    };

export interface VerifyLicenseV2Options {
  now?: Date;
  product?: string;
  publicKeys: Record<string, string>;
  localFingerprints?: readonly LicenseV2Fingerprint[];
  timeState?: LicenseTimeState | null;
  revocation?: LicenseRevocationSnapshot | null;
  trustedIssuers?: readonly string[];
}

const ASCII_ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/;
const RFC3339_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const HEX_SHA256_RE = /^[0-9a-f]{64}$/;
const V2_PAYLOAD_KEYS = new Set([
  'schemaVersion',
  'licenseId',
  'customer',
  'subject',
  'edition',
  'issuedAt',
  'notBefore',
  'expiresAt',
  'maxUsers',
  'features',
  'deploymentBinding',
  'gracePolicy',
  'revocationInfo',
  'issuer',
]);

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

export function canonicalizeJcs(value: unknown): string {
  return stableStringify(value);
}

export function isLicenseEnvelopeV2(value: unknown): value is LicenseEnvelopeV2 {
  return isRecord(value) && value.schemaVersion === LICENSE_V2_SCHEMA;
}

export function parsePublicKeyRing(raw: string, fallbackKeyId = 'default'): Record<string, string> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!isRecord(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [keyId, material] of Object.entries(parsed)) {
        if (typeof material === 'string' && material.trim()) out[keyId] = material.trim();
      }
      return out;
    } catch {
      return {};
    }
  }
  return { [fallbackKeyId]: trimmed };
}

export function getMachineFingerprint(): string {
  const cpus = os.cpus();
  const macs = new Set<string>();
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list ?? []) {
        if (!ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') macs.add(ni.mac);
      }
    }
  } catch {
    macs.add('network-unavailable');
  }
  const parts = [
    os.platform(),
    os.arch(),
    String(os.totalmem()),
    cpus[0]?.model ?? '',
    String(cpus.length),
    [...macs].sort().join(','),
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

export function deploymentFingerprint(deploymentId: string): LicenseV2Fingerprint {
  return {
    scope: 'deployment',
    algorithm: 'sha256',
    value: crypto
      .createHash('sha256')
      .update(`license.v2.deployment|${deploymentId}`)
      .digest('hex'),
  };
}

export function getLocalLicenseFingerprints(opts: { deploymentId?: string | null } = {}) {
  const out: LicenseV2Fingerprint[] = [
    { scope: 'machine', algorithm: 'sha256', value: getMachineFingerprint() },
  ];
  const deploymentId = opts.deploymentId?.trim();
  if (deploymentId) out.push(deploymentFingerprint(deploymentId));
  return out;
}

export function verifyRevocationList(
  list: RevocationListEnvelope,
  publicKeys: Record<string, string>,
): LicenseRevocationSnapshot | null {
  if (!isRecord(list) || list.schemaVersion !== REVOCATION_LIST_SCHEMA) return null;
  if (list.payload?.schemaVersion !== REVOCATION_LIST_SCHEMA) return null;
  if (list.signatureAlgorithm !== LICENSE_V2_ALGORITHM) return null;
  const publicKey = publicKeys[list.keyId];
  if (!publicKey) return null;
  if (!verifyRawEd25519(publicKey, canonicalizeJcs(list.payload), list.signature)) return null;
  return {
    listId: list.payload.listId,
    revokedLicenseIds: list.payload.revokedLicenses.map((entry) => entry.licenseId),
    revokedKeyIds: list.payload.revokedKeyIds,
    validUntil: list.payload.validUntil,
  };
}

export function verifyLicense(
  file: LicenseFile | LicenseEnvelopeV2,
  publicKeyMaterial: string,
  opts: { now?: Date; machineFingerprint?: string; publicKeyId?: string } = {},
): LicenseVerifyResult | LicenseVerifyResultV2 {
  if (isLicenseEnvelopeV2(file)) {
    const fallbackKeyId = opts.publicKeyId ?? file.keyId;
    return verifyLicenseV2(file, {
      now: opts.now,
      publicKeys: parsePublicKeyRing(publicKeyMaterial, fallbackKeyId),
      localFingerprints: opts.machineFingerprint
        ? [{ scope: 'machine', algorithm: 'sha256', value: opts.machineFingerprint }]
        : getLocalLicenseFingerprints(),
    });
  }
  return verifyLicenseV1(file, publicKeyMaterial, opts);
}

export function verifyLicenseV1(
  file: LicenseFile,
  publicKeyMaterial: string,
  opts: { now?: Date; machineFingerprint?: string } = {},
): LicenseVerifyResult {
  const now = opts.now ?? new Date();
  if (!file || typeof file !== 'object' || !file.payload || typeof file.signature !== 'string') {
    return {
      valid: false,
      status: 'INVALID',
      reason: 'license 文件格式无效，需包含 payload 与 signature',
    };
  }
  const key = loadV1PublicKey(publicKeyMaterial);
  if (!key) {
    return {
      valid: false,
      status: 'INVALID',
      reason: '未配置有效的 license 公钥',
      payload: file.payload,
    };
  }

  let signatureOk = false;
  try {
    const message = Buffer.from(stableStringify(file.payload), 'utf8');
    const signature = Buffer.from(file.signature, 'base64');
    signatureOk = crypto.verify(null, message, key, signature);
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) {
    return {
      valid: false,
      status: 'INVALID',
      reason: 'license 签名校验失败',
      payload: file.payload,
    };
  }

  if (file.payload.expiresAt) {
    const expires = new Date(file.payload.expiresAt);
    if (!Number.isNaN(expires.getTime()) && expires.getTime() < now.getTime()) {
      return { valid: false, status: 'EXPIRED', reason: 'license 已过期', payload: file.payload };
    }
  }

  if (
    opts.machineFingerprint &&
    file.payload.machineFingerprint &&
    file.payload.machineFingerprint !== opts.machineFingerprint
  ) {
    return { valid: false, status: 'INVALID', reason: '机器指纹不匹配', payload: file.payload };
  }

  return { valid: true, status: 'ACTIVE', payload: file.payload };
}

export function verifyLicenseV2(
  envelope: LicenseEnvelopeV2,
  opts: VerifyLicenseV2Options,
): LicenseVerifyResultV2 {
  const now = opts.now ?? new Date();
  const product = opts.product ?? LSE_PRODUCT_ID;
  if (!isRecord(envelope) || envelope.schemaVersion !== LICENSE_V2_SCHEMA) {
    return invalidV2('license v2 文件格式无效', 'INVALID_FORMAT');
  }
  if (envelope.signatureAlgorithm !== LICENSE_V2_ALGORITHM) {
    return invalidV2('license 签名算法不受支持', 'INVALID_ALGORITHM', envelope);
  }
  if (envelope.payload?.schemaVersion !== LICENSE_V2_SCHEMA) {
    return invalidV2('license schemaVersion 不一致', 'INVALID_SCHEMA', envelope);
  }
  const shapeError = validateV2Shape(envelope);
  if (shapeError) return invalidV2(shapeError, 'INVALID_PAYLOAD', envelope);

  const publicKey = opts.publicKeys[envelope.keyId];
  if (!publicKey) return invalidV2('未配置匹配 keyId 的 license 公钥', 'NO_PUBLIC_KEY', envelope);
  if (!verifyRawEd25519(publicKey, canonicalizeJcs(envelope.payload), envelope.signature)) {
    return invalidV2('license 签名校验失败', 'INVALID_SIGNATURE', envelope);
  }

  if (opts.trustedIssuers?.length && !opts.trustedIssuers.includes(envelope.payload.issuer)) {
    return invalidV2('license issuer 不受信任', 'UNTRUSTED_ISSUER', envelope);
  }
  if (!envelope.payload.subject.products.includes(product)) {
    return invalidV2('license 未授权当前产品', 'PRODUCT_NOT_LICENSED', envelope);
  }

  const bindingError = verifyBinding(
    envelope.payload.deploymentBinding,
    opts.localFingerprints ?? getLocalLicenseFingerprints(),
  );
  if (bindingError) return invalidV2(bindingError, 'BINDING_MISMATCH', envelope);

  const revocationError = verifyRevocationRequirement(
    envelope.payload,
    opts.revocation ?? null,
    now,
  );
  if (revocationError) return invalidV2(revocationError.reason, revocationError.code, envelope);
  if (opts.revocation) {
    if (opts.revocation.revokedLicenseIds?.includes(envelope.payload.licenseId)) {
      return {
        valid: false,
        status: 'REVOKED',
        payload: envelope.payload,
        envelope,
        reason: 'license 已被吊销',
        code: 'LICENSE_REVOKED',
      };
    }
    if (opts.revocation.revokedKeyIds?.includes(envelope.keyId)) {
      return {
        valid: false,
        status: 'REVOKED',
        payload: envelope.payload,
        envelope,
        reason: 'license 签名密钥已被吊销',
        code: 'KEY_REVOKED',
      };
    }
  }

  const clock = evaluateClock(now, envelope.payload, opts.timeState ?? null);
  if (clock.rollback) {
    return {
      valid: false,
      status: 'INVALID',
      payload: envelope.payload,
      envelope,
      effectiveNow: clock.effectiveNow,
      timeState: clock.nextState,
      reason: '检测到系统时间明显回拨',
      code: 'CLOCK_ROLLBACK',
    };
  }
  const issuedAt = parseStrictUtc(envelope.payload.issuedAt)!;
  if (issuedAt.getTime() > clock.effectiveNow.getTime() + 5 * 60 * 1000) {
    return invalidV2('license 签发时间晚于当前可信时间', 'ISSUED_IN_FUTURE', envelope, clock);
  }
  const notBefore = parseStrictUtc(envelope.payload.notBefore)!;
  if (notBefore.getTime() > clock.effectiveNow.getTime()) {
    return invalidV2('license 尚未生效', 'NOT_BEFORE', envelope, clock);
  }
  const expiresAt = parseStrictUtc(envelope.payload.expiresAt)!;
  const expiryGraceMs =
    clampInt(envelope.payload.gracePolicy.expiryGraceDays, 0, 30) * 24 * 60 * 60 * 1000;
  if (expiresAt.getTime() + expiryGraceMs < clock.effectiveNow.getTime()) {
    return {
      valid: false,
      status: 'EXPIRED',
      payload: envelope.payload,
      envelope,
      effectiveNow: clock.effectiveNow,
      timeState: clock.nextState,
      reason: 'license 已过期',
      code: 'EXPIRED',
    };
  }

  return {
    valid: true,
    status: 'ACTIVE',
    payload: envelope.payload,
    envelope,
    effectiveNow: clock.effectiveNow,
    timeState: clock.nextState,
  };
}

function loadV1PublicKey(material: string): crypto.KeyObject | null {
  if (!material) return null;
  const trimmed = material.trim();
  if (trimmed.includes('BEGIN')) {
    try {
      return crypto.createPublicKey(trimmed);
    } catch {
      return null;
    }
  }
  try {
    const der = Buffer.from(trimmed, 'base64');
    return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

function verifyRawEd25519(publicKeyBase64Url: string, message: string, signatureBase64Url: string) {
  try {
    const raw = Buffer.from(publicKeyBase64Url, 'base64url');
    if (raw.length !== 32) return false;
    const publicKey = crypto.createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]),
      format: 'der',
      type: 'spki',
    });
    const signature = Buffer.from(signatureBase64Url, 'base64url');
    return (
      signature.length === 64 &&
      crypto.verify(null, Buffer.from(message, 'utf8'), publicKey, signature)
    );
  } catch {
    return false;
  }
}

function validateV2Shape(envelope: LicenseEnvelopeV2): string | null {
  if (!ASCII_ID_RE.test(envelope.keyId)) return 'license keyId 格式无效';
  if (
    typeof envelope.signature !== 'string' ||
    Buffer.from(envelope.signature, 'base64url').length !== 64
  ) {
    return 'license signature 格式无效';
  }
  const payload = envelope.payload;
  for (const key of Object.keys(payload)) {
    if (!V2_PAYLOAD_KEYS.has(key)) return `license payload 包含未知字段：${key}`;
  }
  if (!ASCII_ID_RE.test(payload.licenseId)) return 'licenseId 格式无效';
  if (!ASCII_ID_RE.test(payload.issuer)) return 'issuer 格式无效';
  if (!ASCII_ID_RE.test(payload.edition)) return 'edition 格式无效';
  if (
    !isRecord(payload.customer) ||
    typeof payload.customer.displayName !== 'string' ||
    !ASCII_ID_RE.test(payload.customer.id)
  ) {
    return 'customer 字段格式无效';
  }
  if (!isRecord(payload.subject) || typeof payload.subject.displayName !== 'string') {
    return 'subject 字段格式无效';
  }
  if (!Array.isArray(payload.subject.products) || payload.subject.products.length === 0) {
    return 'subject.products 不能为空';
  }
  for (const product of payload.subject.products) {
    if (!ASCII_ID_RE.test(product)) return 'subject.products 包含非法产品标识';
  }
  for (const field of ['issuedAt', 'notBefore', 'expiresAt'] as const) {
    if (!parseStrictUtc(payload[field])) return `${field} 必须为 UTC RFC3339 秒级时间`;
  }
  if (!Number.isInteger(payload.maxUsers) || payload.maxUsers < 0) return 'maxUsers 必须为非负整数';
  if (!Array.isArray(payload.features) || payload.features.length === 0) return 'features 不能为空';
  for (const feature of payload.features) {
    if (!ASCII_ID_RE.test(feature)) return 'features 包含非法标识';
  }
  if (!validateBindingShape(payload.deploymentBinding)) return 'deploymentBinding 格式无效';
  if (!validateGracePolicy(payload.gracePolicy)) return 'gracePolicy 格式无效';
  if (!validateRevocationInfo(payload.revocationInfo)) return 'revocationInfo 格式无效';
  return null;
}

function verifyRevocationRequirement(
  payload: LicenseEnvelopeV2['payload'],
  revocation: LicenseRevocationSnapshot | null,
  now: Date,
): { reason: string; code: string } | null {
  if (payload.revocationInfo.mode !== 'offline-file') return null;
  if (!revocation) {
    return { reason: 'license 要求离线吊销清单，但未读取到有效清单', code: 'REVOCATION_REQUIRED' };
  }
  if (revocation.listId !== payload.revocationInfo.listId) {
    return { reason: '离线吊销清单 listId 与 license 不匹配', code: 'REVOCATION_LIST_MISMATCH' };
  }
  const validUntil = parseStrictUtc(revocation.validUntil);
  if (!validUntil) {
    return { reason: '离线吊销清单 validUntil 无效', code: 'REVOCATION_LIST_INVALID' };
  }
  const staleGraceMs =
    clampInt(payload.gracePolicy.offlineRevocationStaleDays, 0, 90) * 24 * 60 * 60 * 1000;
  if (validUntil.getTime() + staleGraceMs < now.getTime()) {
    return { reason: '离线吊销清单已超过允许宽限期', code: 'REVOCATION_LIST_STALE' };
  }
  return null;
}

function verifyBinding(
  binding: LicenseEnvelopeV2['payload']['deploymentBinding'],
  localFingerprints: readonly LicenseV2Fingerprint[],
): string | null {
  if (binding.mode === 'none') return null;
  const expected = binding.fingerprints ?? [];
  const local = new Set(localFingerprints.map((fp) => `${fp.scope}:${fp.algorithm}:${fp.value}`));
  const matched = expected.some((fp) => local.has(`${fp.scope}:${fp.algorithm}:${fp.value}`));
  if (!matched && binding.mode === 'required') return '部署绑定不匹配';
  if (!matched && localFingerprints.length > 0 && binding.mode === 'optional')
    return '部署绑定不匹配';
  return null;
}

function evaluateClock(
  now: Date,
  payload: LicenseEnvelopeV2['payload'],
  state: LicenseTimeState | null,
) {
  const maxSeen = parseStrictUtc(state?.maxSeenWallTime);
  const nowIso = toStrictUtc(now);
  const graceMs = clampInt(payload.gracePolicy.clockRollbackGraceHours, 0, 48) * 60 * 60 * 1000;
  const rollback = Boolean(maxSeen && now.getTime() + graceMs < maxSeen.getTime());
  const effectiveNow = maxSeen && maxSeen.getTime() > now.getTime() ? maxSeen : now;
  const nextMax = effectiveNow;
  const nextState: LicenseTimeState = {
    schemaVersion: 'license-time-state.v1',
    licenseId: payload.licenseId,
    firstSeenAt: state?.firstSeenAt ?? nowIso,
    lastSeenWallTime: nowIso,
    maxSeenWallTime: toStrictUtc(nextMax),
    clockRollbackDetectedAt: rollback
      ? (state?.clockRollbackDetectedAt ?? nowIso)
      : (state?.clockRollbackDetectedAt ?? null),
  };
  return { rollback, effectiveNow, nextState };
}

function invalidV2(
  reason: string,
  code: string,
  envelope?: LicenseEnvelopeV2,
  clock?: ReturnType<typeof evaluateClock>,
): LicenseVerifyResultV2 {
  return {
    valid: false,
    status: 'INVALID',
    payload: envelope?.payload,
    envelope,
    effectiveNow: clock?.effectiveNow,
    timeState: clock?.nextState,
    reason,
    code,
  };
}

function validateBindingShape(binding: LicenseEnvelopeV2['payload']['deploymentBinding']) {
  if (!isRecord(binding)) return false;
  if (!['none', 'optional', 'required'].includes(String(binding.mode))) return false;
  if (binding.mode === 'none') return true;
  if (typeof binding.bindingId !== 'string' || !ASCII_ID_RE.test(binding.bindingId)) return false;
  if (!Array.isArray(binding.fingerprints) || binding.fingerprints.length === 0) return false;
  return binding.fingerprints.every(
    (fp) =>
      isRecord(fp) &&
      ['machine', 'cluster', 'deployment'].includes(String(fp.scope)) &&
      fp.algorithm === 'sha256' &&
      typeof fp.value === 'string' &&
      HEX_SHA256_RE.test(fp.value),
  );
}

function validateGracePolicy(policy: LicenseEnvelopeV2['payload']['gracePolicy']) {
  return (
    isRecord(policy) &&
    Number.isInteger(policy.expiryGraceDays) &&
    Number.isInteger(policy.clockRollbackGraceHours) &&
    Number.isInteger(policy.offlineRevocationStaleDays) &&
    policy.expiryGraceDays >= 0 &&
    policy.clockRollbackGraceHours >= 0 &&
    policy.offlineRevocationStaleDays >= 0
  );
}

function validateRevocationInfo(info: LicenseEnvelopeV2['payload']['revocationInfo']) {
  if (!isRecord(info) || !['none', 'offline-file', 'online'].includes(String(info.mode)))
    return false;
  if (info.mode === 'none') return true;
  return typeof info.listId === 'string' && ASCII_ID_RE.test(info.listId);
}

function parseStrictUtc(value: unknown): Date | null {
  if (typeof value !== 'string' || !RFC3339_UTC_RE.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toStrictUtc(date: Date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function clampInt(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
