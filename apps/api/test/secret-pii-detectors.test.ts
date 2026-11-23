import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectSecrets,
  detectChinesePII,
  highConfidenceLeaks,
  isValidChinaId,
  isValidUscc,
  detectCanaryLeak,
} from '../src/modules/gateway-logs/secret-pii-detectors.js';

// === 密钥 ===
test('detectSecrets：OpenAI/AWS/GitHub 服务专用正则命中，给高分', () => {
  const out = detectSecrets(
    'key=sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX token AKIAZ1Q2W3E4R5T6Y7U8 gh ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
  );
  const types = out.map((e) => e.entityType);
  assert.ok(types.includes('OpenAI 密钥'));
  assert.ok(types.includes('AWS Access Key'));
  assert.ok(types.includes('GitHub 令牌'));
  assert.ok(out.every((e) => e.score >= 0.9));
});

test('detectSecrets：baseline 白名单(example/your_key/xxxx)不误报', () => {
  const out = detectSecrets('示例：sk-your_api_key_here，或 AKIAXXXXXXXXXXXXXXXX，或 <your-token>');
  assert.equal(out.length, 0);
});

test('detectSecrets：高熵串仅在密钥关键词旁信时命中', () => {
  const near = detectSecrets('密钥: Zx9Kq2Lp7Wm4Rt6Yv8Bn3Cd5Fg1Hj0');
  assert.ok(near.some((e) => e.method === 'entropy_keyword'));
  const far = detectSecrets('这是一段普通文本 Zx9Kq2Lp7Wm4Rt6Yv8Bn3Cd5Fg1Hj0 出现在无关上下文');
  assert.ok(!far.some((e) => e.method === 'entropy_keyword'));
});

// === 中文 PII 校验位 ===
test('isValidChinaId：合法身份证校验位通过、篡改后失败', () => {
  assert.equal(isValidChinaId('110101199001011237'), true);
  assert.equal(isValidChinaId('110101199001011230'), false);
  assert.equal(isValidChinaId('123456789012345678'), false);
});

test('detectChinesePII：合法身份证给高分(校验位)、非法仅格式分', () => {
  const valid = detectChinesePII('我的身份证是 110101199001011237 谢谢');
  const idV = valid.find((e) => e.entityType === '身份证号');
  assert.ok(idV);
  assert.equal(idV.method, 'pii_checksum');
  assert.ok(idV.score >= 0.9);
  const invalid = detectChinesePII('身份证 110101199001011230');
  const idI = invalid.find((e) => e.entityType === '身份证号');
  assert.ok(idI);
  assert.equal(idI.method, 'pii_format');
  assert.ok(idI.score < 0.8);
});

test('detectChinesePII：手机号命中', () => {
  const out = detectChinesePII('联系电话 13812345678');
  assert.ok(out.some((e) => e.entityType === '手机号'));
});

test('isValidUscc：篡改校验位失败', () => {
  // 统一社会信用代码 18 位，末位为校验位；篡改末位必失败
  assert.equal(isValidUscc('91110108000000000A'), false);
  assert.equal(isValidUscc('not-a-valid-uscc!!'), false);
});

// === 高置信硬证据 ===
test('highConfidenceLeaks：只留 score≥0.8（校验位中文PII/服务密钥）', () => {
  const out = highConfidenceLeaks(
    '身份证 110101199001011237，密钥 sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX，邮箱 a@b.com',
  );
  // 身份证(0.99)+OpenAI密钥(0.95) 入选；邮箱(0.5) 不入选
  assert.ok(out.some((e) => e.entityType === '身份证号'));
  assert.ok(out.some((e) => e.entityType === 'OpenAI 密钥'));
  assert.ok(!out.some((e) => e.entityType === '电子邮箱'));
});

test('detectCanaryLeak：诱饵串出现在输出→返回命中，否则 null', () => {
  assert.equal(detectCanaryLeak('结果是 CANARY-AB-123', ['CANARY-AB-123']), 'CANARY-AB-123');
  assert.equal(detectCanaryLeak('一切正常', ['CANARY-AB-123']), null);
});
