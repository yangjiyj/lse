import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashSensitive, redactJson, redactString } from '../src/lib/redact.js';

test('redactString 保留含敏感词汇的良性中文文本', () => {
  const benign = 'API 密钥轮换策略未启用，建议每 90 天更换一次 token';
  assert.equal(redactString(benign), benign);
});

test('redactJson hash jwt 类型 key', () => {
  const obj = { jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.abc' };
  const out = redactJson(obj) as { jwt: string };
  assert.match(String(out.jwt), /^hash:/);
});

test('redactJson hash cookie key', () => {
  const obj = { cookie: 'session=abc123; Path=/' };
  const out = redactJson(obj) as { cookie: string };
  assert.match(String(out.cookie), /^hash:/);
});

test('redactJson hash 数字型敏感 key 值', () => {
  const obj = { apiKey: 9876543210123456 };
  const out = redactJson(obj) as { apiKey: string };
  assert.match(String(out.apiKey), /^hash:/);
  assert.doesNotMatch(String(out.apiKey), /9876543210123456/);
});

test('redactJson 保留非敏感 key 的数字值', () => {
  const obj = { latencyMs: 123, statusCode: 200 };
  const out = redactJson(obj) as { latencyMs: number; statusCode: number };
  assert.equal(out.latencyMs, 123);
  assert.equal(out.statusCode, 200);
});

test('redactString hash JWT token 但保留上下文字段名', () => {
  const s =
    'X-Auth-Token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const out = redactString(s);
  assert.doesNotMatch(out, /eyJhbGci/);
  assert.match(out, /^X-Auth-Token: hash:[0-9a-f]{12}$/);
});

test('redactString hash Basic 凭证但保留 Authorization 标签', () => {
  const s = 'Authorization: Basic dXNlcjpwYXNzd29yZC1sb25nLXNlY3JldA==';
  const out = redactString(s);
  assert.doesNotMatch(out, /dXNlcj/);
  assert.match(out, /^Authorization: hash:[0-9a-f]{12}$/);
});

test('redactString hash Google API key 形态', () => {
  const key = `AIza${'A'.repeat(35)}`;
  const out = redactString(`googleKey=${key}`);
  assert.doesNotMatch(out, new RegExp(key));
  assert.match(out, /^googleKey=hash:[0-9a-f]{12}$/);
});

test('redactString hash URL 中的 userinfo 密码', () => {
  const url = 'https://admin:s3cr3tPass@control.internal:8443/v1';
  const out = redactString(url);
  assert.doesNotMatch(out, /s3cr3tPass/);
  assert.match(out, /admin:/);
  assert.match(out, /hash:[0-9a-f]{12}/);
});

test('redactString hash 敏感标签后的值但保留上下文', () => {
  const out = redactString(
    'password=hunter2plain2pw; API key abc-plain-key; secret abc-plain-key; note ok',
  );
  assert.doesNotMatch(out, /hunter2plain2pw/);
  assert.doesNotMatch(out, /abc-plain-key/);
  assert.match(
    out,
    /^password=hash:[0-9a-f]{12}; API key hash:[0-9a-f]{12}; secret hash:[0-9a-f]{12}; note ok$/,
  );
});

test('redactString 覆盖 AWS、GitHub、PEM 与文本内嵌 URL 凭据', () => {
  const awsAkia = 'AKIA1234567890ABCDEF';
  const awsAsia = 'ASIA1234567890ABCDEF';
  const awsAgpa = 'AGPA1234567890ABCDEF';
  const awsAida = 'AIDA1234567890ABCDEF';
  const awsAroa = 'AROA1234567890ABCDEF';
  const github = 'ghp_1234567890abcdefghijklmnopqrstuvwxyz';
  const pem = [
    '-----BEGIN PRIVATE KEY-----',
    'c3VwZXItc2VjcmV0LXByaXZhdGUta2V5',
    '-----END PRIVATE KEY-----',
  ].join('\n');
  const embeddedPassword = 'embedded-url-password';
  const input = [
    awsAkia,
    awsAsia,
    awsAgpa,
    awsAida,
    awsAroa,
    github,
    pem,
    `调用 https://admin:${embeddedPassword}@control.internal:8443/v1 完成检查`,
  ].join('\n');

  const out = redactString(input);
  for (const secret of [
    awsAkia,
    awsAsia,
    awsAgpa,
    awsAida,
    awsAroa,
    github,
    pem,
    embeddedPassword,
  ]) {
    assert.doesNotMatch(out, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(out, /hash:[0-9a-f]{12}/);
  assert.match(out, /control\.internal/);
});
test('redactString 线性处理大量无 END 的 PEM 起始标记并遮蔽剩余内容', () => {
  const marker = '-----BEGIN PRIVATE KEY-----\n';
  const input = `prefix\n${marker.repeat(18_000)}opaque-private-tail`;
  assert.ok(input.length >= 500_000, '回归样本必须覆盖至少 0.5MB 输入');

  const startedAt = performance.now();
  const out = redactString(input);
  const elapsedMs = performance.now() - startedAt;

  assert.ok(elapsedMs < 1_000, `无闭合 PEM 脱敏耗时 ${elapsedMs.toFixed(1)}ms，应小于 1s`);
  assert.match(out, /^prefix\nhash:[0-9a-f]{12}$/);
  assert.doesNotMatch(out, /BEGIN PRIVATE KEY|opaque-private-tail/);
});

test('redactString 遮蔽多个完整 PEM 块并保留块外文本', () => {
  const first = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'Zmlyc3QtcHJpdmF0ZS1rZXk=',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n');
  const second = [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'c2Vjb25kLXByaXZhdGUta2V5',
    '-----END OPENSSH PRIVATE KEY-----',
  ].join('\n');

  const out = redactString(`before\n${first}\nbetween\n${second}\nafter`);
  assert.match(out, /^before\nhash:[0-9a-f]{12}\nbetween\nhash:[0-9a-f]{12}\nafter$/);
  assert.doesNotMatch(out, /PRIVATE KEY|Zmlyc3Q|c2Vjb25k/);
});

test('hashSensitive 与已脱敏 Bearer 文本重复执行保持幂等', () => {
  const once = hashSensitive('idempotent-secret-value');
  assert.equal(hashSensitive(once), once);

  const bearerOnce = redactString('Authorization: Bearer idempotent-bearer-secret');
  const bearerTwice = redactString(bearerOnce);
  assert.equal(bearerTwice, bearerOnce);
});
