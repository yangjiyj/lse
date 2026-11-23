import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  verifyLicenseV2,
  getLocalLicenseFingerprints,
  type LicenseEnvelopeV2,
} from '../src/lib/license.js';

// 端到端验证 Phase 0 密钥收口（测评侧）：一张由生产签发身份
// (keyId lse-lic-2026, issuer huoxianbao-license-authority-prod) 签发、
// 绑定到 deploymentId 的 v2 续费 license，必须能被测评真实验签链接受且绑定匹配。
// 历史"单复数断链 / 信任错 key"雷区的回归护栏。
const SIGNING_RING: Record<string, string> = {
  'lse-lic-2026': 'WxiAqCV0BUqVnopcPSrOWcVlowUoz1JQtGyEUCZ2f_Y',
};
const PROD_ISSUER = 'huoxianbao-license-authority-prod';

function loadFixture(): LicenseEnvelopeV2 {
  const raw = readFileSync(path.join(import.meta.dirname, 'e2e_lse_license.json'), 'utf8');
  return JSON.parse(raw) as LicenseEnvelopeV2;
}

test('E2E: 生产签发身份的续费 license 验签通过 + 绑定匹配', () => {
  const envelope = loadFixture();
  const ok = verifyLicenseV2(envelope, {
    publicKeys: SIGNING_RING,
    product: 'llm-safety-eval-platform',
    trustedIssuers: [PROD_ISSUER],
    localFingerprints: getLocalLicenseFingerprints({ deploymentId: 'dep_e2e_lse' }),
  });
  assert.equal(ok.valid, true, ok.reason);
});

test('E2E: 换台机器(deploymentId 不同) → 绑定不匹配被拒', () => {
  const envelope = loadFixture();
  const bad = verifyLicenseV2(envelope, {
    publicKeys: SIGNING_RING,
    product: 'llm-safety-eval-platform',
    trustedIssuers: [PROD_ISSUER],
    localFingerprints: getLocalLicenseFingerprints({ deploymentId: 'dep_other_machine' }),
  });
  assert.equal(bad.valid, false);
  assert.equal(bad.code, 'BINDING_MISMATCH');
});
