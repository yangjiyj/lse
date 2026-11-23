import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { licenseEnforcePolicyError, resolveLicenseEnforce } from '../src/config.js';
import {
  canonicalizeJcs,
  verifyLicense,
  verifyLicenseV2,
  verifyRevocationList,
  getMachineFingerprint,
  stableStringify,
  type LicenseEnvelopeV2,
  type LicenseFile,
  type RevocationListEnvelope,
} from '../src/lib/license.js';
import {
  ensureInstallSeed,
  getActiveLicenseState,
  readInstallAt,
  sanitizeLicenseStatusResponse,
  verifyStoredLicenseForRuntime,
} from '../src/lib/license-enforcement.js';
import { prisma } from '../src/db.js';
import { buildApp } from '../src/app.js';

function makeKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return {
    privateKey,
    publicB64: pubDer.toString('base64'),
    publicRawB64Url: pubDer.subarray(-32).toString('base64url'),
  };
}

function signLicense(
  privateKey: ReturnType<typeof makeKeypair>['privateKey'],
  payload: Record<string, unknown>,
): LicenseFile {
  const message = Buffer.from(stableStringify(payload), 'utf8');
  const signature = edSign(null, message, privateKey).toString('base64');
  return { payload, signature };
}

function signV2Payload(
  privateKey: ReturnType<typeof makeKeypair>['privateKey'],
  payload: LicenseEnvelopeV2['payload'],
  keyId = 'test-key',
): LicenseEnvelopeV2 {
  return {
    schemaVersion: 'license.v2',
    payload,
    signatureAlgorithm: 'Ed25519-JCS-B64URL',
    keyId,
    signature: edSign(null, Buffer.from(canonicalizeJcs(payload), 'utf8'), privateKey).toString(
      'base64url',
    ),
  };
}

function signRevocationList(
  privateKey: ReturnType<typeof makeKeypair>['privateKey'],
  payload: RevocationListEnvelope['payload'],
  keyId = 'test-key',
): RevocationListEnvelope {
  return {
    schemaVersion: 'license-revocation-list.v1',
    payload,
    signatureAlgorithm: 'Ed25519-JCS-B64URL',
    keyId,
    signature: edSign(null, Buffer.from(canonicalizeJcs(payload), 'utf8'), privateKey).toString(
      'base64url',
    ),
  };
}

function makeV2Payload(
  overrides: Partial<LicenseEnvelopeV2['payload']> = {},
): LicenseEnvelopeV2['payload'] {
  return {
    schemaVersion: 'license.v2',
    licenseId: 'lic_test_001',
    customer: { id: 'cust_test', displayName: 'Test Customer' },
    subject: { displayName: 'Test Subject', products: ['llm-safety-eval-platform'] },
    edition: 'enterprise',
    issuedAt: '2026-06-21T00:00:00Z',
    notBefore: '2026-06-21T00:00:00Z',
    expiresAt: '2027-12-31T23:59:59Z',
    maxUsers: 10,
    features: ['web_ai'],
    deploymentBinding: { mode: 'none' },
    gracePolicy: {
      expiryGraceDays: 0,
      clockRollbackGraceHours: 0,
      offlineRevocationStaleDays: 3,
    },
    revocationInfo: { mode: 'none' },
    issuer: 'test-issuer',
    ...overrides,
  };
}

test('fingerprint is a stable 64-hex string', () => {
  const fp = getMachineFingerprint();
  assert.match(fp, /^[0-9a-f]{64}$/);
  assert.equal(fp, getMachineFingerprint());
});

test('LICENSE_ENFORCE defaults on and can only be disabled explicitly outside production', () => {
  assert.equal(resolveLicenseEnforce({ NODE_ENV: 'development' }), true);
  assert.equal(resolveLicenseEnforce({ NODE_ENV: 'test' }), true);
  assert.equal(resolveLicenseEnforce({ NODE_ENV: 'production' }), true);
  assert.equal(resolveLicenseEnforce({ NODE_ENV: 'development', LICENSE_ENFORCE: 'false' }), false);
  assert.equal(resolveLicenseEnforce({ NODE_ENV: 'test', LICENSE_ENFORCE: 'false' }), false);
  assert.equal(
    licenseEnforcePolicyError({ NODE_ENV: 'production', LICENSE_ENFORCE: false }),
    'LICENSE_ENFORCE=false is not allowed when NODE_ENV=production',
  );
  assert.equal(
    licenseEnforcePolicyError({ NODE_ENV: 'development', LICENSE_ENFORCE: false }),
    null,
  );
  assert.equal(licenseEnforcePolicyError({ NODE_ENV: 'test', LICENSE_ENFORCE: false }), null);
});

test('valid signed license verifies ACTIVE', () => {
  const { privateKey, publicB64 } = makeKeypair();
  const file = signLicense(privateKey, {
    subject: 'ACME 客户',
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  const r = verifyLicense(file, publicB64, {});
  assert.equal(r.valid, true);
  if (r.valid) assert.equal(r.status, 'ACTIVE');
});

test('tampered payload fails signature', () => {
  const { privateKey, publicB64 } = makeKeypair();
  const file = signLicense(privateKey, { subject: 'ACME', expiresAt: '2999-01-01T00:00:00.000Z' });
  file.payload.subject = 'EVIL';
  const r = verifyLicense(file, publicB64, {});
  assert.equal(r.valid, false);
});

test('expired license is rejected', () => {
  const { privateKey, publicB64 } = makeKeypair();
  const file = signLicense(privateKey, { subject: 'ACME', expiresAt: '2000-01-01T00:00:00.000Z' });
  const r = verifyLicense(file, publicB64, {});
  assert.equal(r.valid, false);
  if (!r.valid) assert.equal(r.status, 'EXPIRED');
});

test('fingerprint mismatch is rejected', () => {
  const { privateKey, publicB64 } = makeKeypair();
  const file = signLicense(privateKey, {
    subject: 'ACME',
    expiresAt: '2999-01-01T00:00:00.000Z',
    machineFingerprint: 'deadbeef',
  });
  const r = verifyLicense(file, publicB64, { machineFingerprint: 'cafef00d' });
  assert.equal(r.valid, false);
});

test('empty public key yields NO_KEY status', () => {
  const { privateKey } = makeKeypair();
  const file = signLicense(privateKey, { subject: 'ACME' });
  const r = verifyLicense(file, '', {});
  assert.equal(r.valid, false);
});

const vectorPayload = {
  schemaVersion: 'license.v2',
  licenseId: 'lic_v2_test_vector_001',
  customer: {
    id: 'cust_example_gov',
    displayName: 'Example Government Customer',
  },
  subject: {
    displayName: '政企安全网关联合授权',
    products: ['llm-safety-eval-platform', 'newapi-enterprise'],
  },
  edition: 'enterprise',
  issuedAt: '2026-06-21T00:00:00Z',
  notBefore: '2026-06-21T00:00:00Z',
  expiresAt: '2027-12-31T23:59:59Z',
  maxUsers: 500,
  features: ['agent_audit', 'content_retention', 'ide_proxy', 'sensitive_data_guard', 'web_ai'],
  deploymentBinding: {
    mode: 'required',
    bindingId: 'dep_x7f9',
    fingerprints: [
      {
        scope: 'machine',
        algorithm: 'sha256',
        value: '1c4f2b0a9f2c8a1e3d5b6c7d8e9f00112233445566778899aabbccddeeff0011', // pragma: allowlist secret
      },
    ],
  },
  gracePolicy: {
    expiryGraceDays: 7,
    clockRollbackGraceHours: 24,
    offlineRevocationStaleDays: 30,
  },
  revocationInfo: {
    mode: 'offline-file',
    listId: 'rl_prod_cn_001',
    url: 'offline-package://revocations/newapi-lse.json',
  },
  issuer: 'huoxianbao-license-authority-prod',
} satisfies LicenseEnvelopeV2['payload'];

const vectorCanonical =
  '{"customer":{"displayName":"Example Government Customer","id":"cust_example_gov"},"deploymentBinding":{"bindingId":"dep_x7f9","fingerprints":[{"algorithm":"sha256","scope":"machine","value":"1c4f2b0a9f2c8a1e3d5b6c7d8e9f00112233445566778899aabbccddeeff0011"}],"mode":"required"},"edition":"enterprise","expiresAt":"2027-12-31T23:59:59Z","features":["agent_audit","content_retention","ide_proxy","sensitive_data_guard","web_ai"],"gracePolicy":{"clockRollbackGraceHours":24,"expiryGraceDays":7,"offlineRevocationStaleDays":30},"issuedAt":"2026-06-21T00:00:00Z","issuer":"huoxianbao-license-authority-prod","licenseId":"lic_v2_test_vector_001","maxUsers":500,"notBefore":"2026-06-21T00:00:00Z","revocationInfo":{"listId":"rl_prod_cn_001","mode":"offline-file","url":"offline-package://revocations/newapi-lse.json"},"schemaVersion":"license.v2","subject":{"displayName":"政企安全网关联合授权","products":["llm-safety-eval-platform","newapi-enterprise"]}}'; // pragma: allowlist secret

const vectorEnvelope = {
  schemaVersion: 'license.v2',
  payload: vectorPayload,
  signatureAlgorithm: 'Ed25519-JCS-B64URL',
  keyId: 'hxb-prod-lic-2026-01',
  signature:
    '9Fptnm0N2rvUfNRzutMR7xbediQqFyljtpYhaf-yWOQDlm6n7KOWaNypGZIXmXvNOAgMkHcjJswwrgsuplfkBA', // pragma: allowlist secret
} satisfies LicenseEnvelopeV2;

test('License v2 canonical matches unified JCS vector byte-for-byte', () => {
  const canonical = canonicalizeJcs(vectorPayload);
  assert.equal(canonical, vectorCanonical);
  assert.equal(
    createHash('sha256').update(canonical, 'utf8').digest('hex'),
    '14eb18aff98592694e08e35e07bd3e7371d807d94bfd866dfa5d809ed8519685', // pragma: allowlist secret
  );
});

test('License v2 unified signature vector verifies with raw keyId public key', () => {
  const r = verifyLicenseV2(vectorEnvelope, {
    now: new Date('2026-06-22T00:00:00Z'),
    product: 'llm-safety-eval-platform',
    publicKeys: { 'hxb-prod-lic-2026-01': 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg' }, // pragma: allowlist secret
    localFingerprints: [
      {
        scope: 'machine',
        algorithm: 'sha256',
        value: '1c4f2b0a9f2c8a1e3d5b6c7d8e9f00112233445566778899aabbccddeeff0011', // pragma: allowlist secret
      },
    ],
    revocation: {
      listId: 'rl_prod_cn_001',
      revokedLicenseIds: [],
      revokedKeyIds: [],
      validUntil: '2026-06-30T00:00:00Z',
    },
  });
  assert.equal(r.valid, true);
  if (r.valid) {
    assert.equal(r.status, 'ACTIVE');
    assert.equal(r.payload.licenseId, 'lic_v2_test_vector_001');
  }
});

test('License v2 rejects tampering, product mismatch, binding mismatch, revocation, and rollback', () => {
  const baseOpts = {
    now: new Date('2026-06-22T00:00:00Z'),
    product: 'llm-safety-eval-platform',
    publicKeys: { 'hxb-prod-lic-2026-01': 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg' }, // pragma: allowlist secret
    localFingerprints: [
      {
        scope: 'machine',
        algorithm: 'sha256',
        value: '1c4f2b0a9f2c8a1e3d5b6c7d8e9f00112233445566778899aabbccddeeff0011', // pragma: allowlist secret
      },
    ],
    revocation: {
      listId: 'rl_prod_cn_001',
      revokedLicenseIds: [],
      revokedKeyIds: [],
      validUntil: '2026-06-30T00:00:00Z',
    },
  } as const;

  const tampered: LicenseEnvelopeV2 = {
    ...vectorEnvelope,
    payload: { ...vectorPayload, maxUsers: 999 },
  };
  assert.equal(verifyLicenseV2(tampered, baseOpts).valid, false);
  assert.equal(
    verifyLicenseV2(vectorEnvelope, { ...baseOpts, product: 'new-product' }).valid,
    false,
  );
  assert.equal(
    verifyLicenseV2(vectorEnvelope, {
      ...baseOpts,
      localFingerprints: [
        {
          scope: 'machine',
          algorithm: 'sha256',
          value: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        },
      ],
    }).valid,
    false,
  );
  assert.equal(
    verifyLicenseV2(vectorEnvelope, {
      ...baseOpts,
      revocation: {
        listId: 'rl_prod_cn_001',
        revokedLicenseIds: ['lic_v2_test_vector_001'],
        revokedKeyIds: [],
        validUntil: '2026-06-30T00:00:00Z',
      },
    }).status,
    'REVOKED',
  );
  assert.equal(
    verifyLicenseV2(vectorEnvelope, {
      ...baseOpts,
      timeState: { maxSeenWallTime: '2026-06-24T01:00:00Z' },
    }).valid,
    false,
  );
});

test('License v2 offline-file revocation mode requires a fresh matching signed list', () => {
  const { privateKey, publicRawB64Url } = makeKeypair();
  const payload = makeV2Payload({
    revocationInfo: { mode: 'offline-file', listId: 'rl_test_001' },
  });
  const envelope = signV2Payload(privateKey, payload);
  const publicKeys = { 'test-key': publicRawB64Url };

  const missingList = verifyLicenseV2(envelope, {
    now: new Date('2026-06-22T00:00:00Z'),
    publicKeys,
  });
  assert.equal(missingList.valid, false);
  if (!missingList.valid) assert.equal(missingList.code, 'REVOCATION_REQUIRED');

  const mismatchedList = verifyLicenseV2(envelope, {
    now: new Date('2026-06-22T00:00:00Z'),
    publicKeys,
    revocation: {
      listId: 'rl_other',
      revokedLicenseIds: [],
      revokedKeyIds: [],
      validUntil: '2026-06-22T00:00:00Z',
    },
  });
  assert.equal(mismatchedList.valid, false);
  if (!mismatchedList.valid) assert.equal(mismatchedList.code, 'REVOCATION_LIST_MISMATCH');

  const expiredList = verifyLicenseV2(envelope, {
    now: new Date('2026-06-26T00:00:01Z'),
    publicKeys,
    revocation: {
      listId: 'rl_test_001',
      revokedLicenseIds: [],
      revokedKeyIds: [],
      validUntil: '2026-06-22T00:00:00Z',
    },
  });
  assert.equal(expiredList.valid, false);
  if (!expiredList.valid) assert.equal(expiredList.code, 'REVOCATION_LIST_STALE');

  const freshList = verifyLicenseV2(envelope, {
    now: new Date('2026-06-24T00:00:00Z'),
    publicKeys,
    revocation: {
      listId: 'rl_test_001',
      revokedLicenseIds: [],
      revokedKeyIds: [],
      validUntil: '2026-06-22T00:00:00Z',
    },
  });
  assert.equal(freshList.valid, true);
});

test('signed revocation list verification exposes listId and rejects bad signatures', () => {
  const { privateKey, publicRawB64Url } = makeKeypair();
  const list = signRevocationList(privateKey, {
    schemaVersion: 'license-revocation-list.v1',
    listId: 'rl_test_001',
    issuer: 'test-issuer',
    issuedAt: '2026-06-21T00:00:00Z',
    validUntil: '2026-06-30T00:00:00Z',
    revokedLicenses: [{ licenseId: 'lic_test_001', revokedAt: '2026-06-22T00:00:00Z' }],
    revokedKeyIds: ['old-key'],
  });
  const snapshot = verifyRevocationList(list, { 'test-key': publicRawB64Url });
  assert.deepEqual(snapshot, {
    listId: 'rl_test_001',
    revokedLicenseIds: ['lic_test_001'],
    revokedKeyIds: ['old-key'],
    validUntil: '2026-06-30T00:00:00Z',
  });

  const tampered = {
    ...list,
    payload: { ...list.payload, listId: 'rl_other' },
  };
  assert.equal(verifyRevocationList(tampered, { 'test-key': publicRawB64Url }), null);
});

test('v1 runtime verification enforces stored machineFingerprint', async () => {
  const { privateKey, publicB64 } = makeKeypair();
  const file = signLicense(privateKey, {
    subject: 'ACME',
    expiresAt: '2999-01-01T00:00:00.000Z',
    machineFingerprint: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  });
  const result = await verifyStoredLicenseForRuntime(file, {
    now: new Date('2026-06-22T00:00:00Z'),
    publicKey: publicB64,
    publicKeys: {},
    deploymentId: null,
    timeState: null,
    revocation: null,
  });
  assert.equal(result.valid, false);
  if (!result.valid) assert.match(result.reason, /机器指纹不匹配/);
});

test('license status response omits internal ids and binding fingerprints', () => {
  const response = sanitizeLicenseStatusResponse({
    configured: true,
    enforce: true,
    publicKeyConfigured: true,
    publicKeyRingConfigured: true,
    license: {
      id: 'db-id',
      subject: 'ACME',
      status: 'ACTIVE',
      valid: true,
      keyId: 'key-id',
      licenseId: 'lic-id',
      machineFingerprint: 'raw-machine',
      deploymentBinding: { mode: 'required', fingerprints: [{ value: 'secret' }] },
      fingerprints: [{ value: 'secret' }],
      features: ['web_ai'],
      products: ['llm-safety-eval-platform'],
      maxUsers: 10,
      edition: 'enterprise',
    },
  });
  assert.equal(response.license?.subject, 'ACME');
  assert.equal(response.license?.status, 'ACTIVE');
  assert.equal('id' in response.license!, false);
  assert.equal('keyId' in response.license!, false);
  assert.equal('licenseId' in response.license!, false);
  assert.equal('machineFingerprint' in response.license!, false);
  assert.equal('deploymentBinding' in response.license!, false);
  assert.equal('fingerprints' in response.license!, false);
  assert.equal('features' in response.license!, false);
  assert.equal('products' in response.license!, false);
});

test('ensureInstallSeed 首次写入 installAt 与 deploymentId，二次幂等', async () => {
  await prisma.systemSetting.deleteMany({
    where: { key: { in: ['license.installAt', 'license.deploymentId'] } },
  });

  await ensureInstallSeed();
  const a1 = await prisma.systemSetting.findUnique({ where: { key: 'license.installAt' } });
  const d1 = await prisma.systemSetting.findUnique({ where: { key: 'license.deploymentId' } });
  assert.ok(a1?.value, 'installAt 应被写入');

  // deploymentId: 仅当 env 未提供时才落库；断言 DB 有值或 env 已提供
  const envDep = process.env.LICENSE_DEPLOYMENT_ID?.trim() ?? '';
  if (envDep) {
    assert.equal(d1, null, 'env 提供 deploymentId 时不应写 DB');
  } else {
    assert.ok(d1?.value, 'env 未提供时 deploymentId 应落库');
    assert.match(String(d1!.value), /^dep_/);
  }

  // readInstallAt 返回可解析的日期
  const at = await readInstallAt();
  assert.ok(at instanceof Date && !Number.isNaN(at.getTime()));

  // 二次调用：幂等，不覆盖 installAt
  await ensureInstallSeed();
  const a2 = await prisma.systemSetting.findUnique({ where: { key: 'license.installAt' } });
  assert.equal(a2!.value, a1!.value);
  const d2 = await prisma.systemSetting.findUnique({ where: { key: 'license.deploymentId' } });
  assert.equal(d2?.value ?? null, d1?.value ?? null);
});

test('enforce 模式下无 license 但试用期内 → 有效且含全功能', async () => {
  const prevInstallAt = await prisma.systemSetting.findUnique({
    where: { key: 'license.installAt' },
  });
  const prevActive = await prisma.license.findMany({
    where: { isActive: true },
    select: { id: true },
  });
  try {
    await prisma.license.updateMany({ where: { isActive: true }, data: { isActive: false } });
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString();
    await prisma.systemSetting.upsert({
      where: { key: 'license.installAt' },
      update: { value: tenDaysAgo },
      create: { key: 'license.installAt', value: tenDaysAgo },
    });
    const state = await getActiveLicenseState(new Date(), { forceEnforced: true });
    assert.equal(state.valid, true);
    assert.equal(state.status, 'TRIAL');
    assert.ok(state.payload?.features?.includes('agent_audit'));
  } finally {
    if (prevInstallAt) {
      await prisma.systemSetting.update({
        where: { key: 'license.installAt' },
        data: { value: prevInstallAt.value as never },
      });
    } else {
      await prisma.systemSetting.deleteMany({ where: { key: 'license.installAt' } });
    }
    if (prevActive.length) {
      await prisma.license.updateMany({
        where: { id: { in: prevActive.map((r) => r.id) } },
        data: { isActive: true },
      });
    }
  }
});

test('enforce 模式下无 license 且试用已过期 → 失效', async () => {
  const prevInstallAt = await prisma.systemSetting.findUnique({
    where: { key: 'license.installAt' },
  });
  const prevActive = await prisma.license.findMany({
    where: { isActive: true },
    select: { id: true },
  });
  try {
    await prisma.license.updateMany({ where: { isActive: true }, data: { isActive: false } });
    const longAgo = new Date(Date.now() - 200 * 86400000).toISOString();
    await prisma.systemSetting.upsert({
      where: { key: 'license.installAt' },
      update: { value: longAgo },
      create: { key: 'license.installAt', value: longAgo },
    });
    const state = await getActiveLicenseState(new Date(), { forceEnforced: true });
    assert.equal(state.valid, false);
  } finally {
    if (prevInstallAt) {
      await prisma.systemSetting.update({
        where: { key: 'license.installAt' },
        data: { value: prevInstallAt.value as never },
      });
    } else {
      await prisma.systemSetting.deleteMany({ where: { key: 'license.installAt' } });
    }
    if (prevActive.length) {
      await prisma.license.updateMany({
        where: { id: { in: prevActive.map((r) => r.id) } },
        data: { isActive: true },
      });
    }
  }
});

test('GET /api/license/host-info 返回产品/deploymentId/fingerprint', async () => {
  const app = await buildApp();
  await app.ready();
  try {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'Admin@12345' }, // pragma: allowlist secret
    });
    assert.equal(login.statusCode, 200, login.body);
    const token = login.json().token as string;

    const res = await app.inject({
      method: 'GET',
      url: '/api/license/host-info',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.product, 'llm-safety-eval-platform');
    assert.match(String(body.deploymentId ?? ''), /\S/); // 非空
    assert.match(String(body.machineFingerprint ?? ''), /^[0-9a-f]{64}$/); // sha256 hex

    const unauth = await app.inject({ method: 'GET', url: '/api/license/host-info' });
    assert.equal(unauth.statusCode, 401);
  } finally {
    await app.close();
  }
});
