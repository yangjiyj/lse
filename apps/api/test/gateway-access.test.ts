import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveInternalToken, assertControlPlaneAllowed } from '../src/lib/gateway-access.js';
import { AppError } from '../src/lib/errors.js';

// ① G3 凭证外泄：网关审计内部令牌只认专用环境变量；Control Plane 出站地址走白名单收敛。

test('仅设置遗留的 NEWAPI_INTERNAL_API_SECRET 时不再被当作网关审计令牌，503 fail-fast', () => {
  try {
    resolveInternalToken({ NEWAPI_INTERNAL_API_SECRET: 'legacy-internal-secret' });
    assert.fail('应当抛出未配置网关审计令牌异常');
  } catch (err) {
    assert.ok(err instanceof AppError);
    assert.equal(err.statusCode, 503);
    assert.equal(err.code, 'GATEWAY_AUDIT_TOKEN_REQUIRED');
  }
});

test('设置 NEWAPI_EVAL_INTEGRATION_TOKEN 时正常返回该令牌', () => {
  const token = resolveInternalToken({ NEWAPI_EVAL_INTEGRATION_TOKEN: 'gw-token-xyz' });
  assert.equal(token, 'gw-token-xyz');
});

test('两个环境变量都未设置时 503 fail-fast', () => {
  try {
    resolveInternalToken({});
    assert.fail('应当抛出未配置网关审计令牌异常');
  } catch (err) {
    assert.ok(err instanceof AppError);
    assert.equal(err.statusCode, 503);
    assert.equal(err.code, 'GATEWAY_AUDIT_TOKEN_REQUIRED');
  }
});

test('未配置 allowlist 时拒绝云元数据地址 169.254.169.254', () => {
  assert.throws(
    () => assertControlPlaneAllowed('http://169.254.169.254/latest/meta-data/', {}),
    (err: unknown) => err instanceof AppError && err.statusCode === 403,
  );
});

test('未配置 allowlist 时放行内网 RFC1918（放开内网，访问控制靠密钥握手而非 IP 白名单）', () => {
  assert.doesNotThrow(() => assertControlPlaneAllowed('http://192.168.1.1:8080/api', {}));
});

test('未配置 allowlist 时拒绝 loopback 127.0.0.1', () => {
  assert.throws(
    () => assertControlPlaneAllowed('http://127.0.0.1:6379', {}),
    (err: unknown) => err instanceof AppError && err.statusCode === 403,
  );
});

test('未配置 allowlist 时放行公网地址', () => {
  assert.doesNotThrow(() => assertControlPlaneAllowed('https://api.example.com/v1', {}));
});

test('白名单按 hostname 命中时放行', () => {
  assert.doesNotThrow(() =>
    assertControlPlaneAllowed('https://cp.example.com/control/api', {
      GATEWAY_CONTROL_PLANE_ALLOWLIST: 'cp.example.com, other.internal',
    }),
  );
});

test('白名单按 host:port 命中时放行', () => {
  assert.doesNotThrow(() =>
    assertControlPlaneAllowed('http://127.0.0.1:8181/analyze', {
      GATEWAY_CONTROL_PLANE_ALLOWLIST: '127.0.0.1:8181',
    }),
  );
});

test('地址不在白名单内时 403 拒绝', () => {
  try {
    assertControlPlaneAllowed('http://169.254.169.254/latest/meta-data', {
      GATEWAY_CONTROL_PLANE_ALLOWLIST: 'cp.example.com, 127.0.0.1:8181',
    });
    assert.fail('应当拒绝不在白名单内的地址');
  } catch (err) {
    assert.ok(err instanceof AppError);
    assert.equal(err.statusCode, 403);
    assert.equal(err.code, 'GATEWAY_CONTROL_PLANE_NOT_ALLOWED');
  }
});

test('配置了白名单但地址格式非法时 400 拒绝', () => {
  try {
    assertControlPlaneAllowed('not a url', {
      GATEWAY_CONTROL_PLANE_ALLOWLIST: 'cp.example.com',
    });
    assert.fail('应当拒绝格式非法的地址');
  } catch (err) {
    assert.ok(err instanceof AppError);
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, 'GATEWAY_CONTROL_PLANE_INVALID');
  }
});

test('allowlist hostname-only 不匹配带端口的同名地址', () => {
  assert.throws(
    () =>
      assertControlPlaneAllowed('http://allowed-host.internal:9200/api', {
        GATEWAY_CONTROL_PLANE_ALLOWLIST: 'allowed-host.internal',
      }),
    (err: unknown) => err instanceof AppError && err.statusCode === 403,
  );
});

test('allowlist hostname:port 形式仍匹配正确', () => {
  assert.doesNotThrow(() =>
    assertControlPlaneAllowed('http://allowed-host.internal:9200/api', {
      GATEWAY_CONTROL_PLANE_ALLOWLIST: 'allowed-host.internal:9200',
    }),
  );
});

test('allowlist 允许 trailing-dot FQDN', () => {
  assert.doesNotThrow(() =>
    assertControlPlaneAllowed('http://control-plane.internal./api', {
      GATEWAY_CONTROL_PLANE_ALLOWLIST: 'control-plane.internal',
    }),
  );
});
