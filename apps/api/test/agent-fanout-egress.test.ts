import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedEgress,
  type EgressPolicy,
} from '../src/modules/agent-evals/fanout/egress-guard.js';

const policy: EgressPolicy = { allowHosts: ['127.0.0.1:41234'] };

test('放行白名单内的平台 sink host', () => {
  assert.equal(isAllowedEgress('http://127.0.0.1:41234/sink/t/html_body', policy), true);
  assert.equal(isAllowedEgress('http://127.0.0.1:41234/exfil/t?c=LSE-FANOUT-x', policy), true);
  assert.equal(isAllowedEgress('https://127.0.0.1:41234/sink/t/html_body', policy), true); // https 同 host 也放行
});

test('拦截白名单外的任意目的地（SSRF/外泄尝试）', () => {
  assert.equal(isAllowedEgress('http://evil.example/collect', policy), false);
  assert.equal(isAllowedEgress('http://169.254.169.254/latest/meta-data/', policy), false);
  assert.equal(isAllowedEgress('http://127.0.0.1:8080/other', policy), false); // 端口不符
  assert.equal(isAllowedEgress('http://127.0.0.1:41234@evil.example/x', policy), false); // userinfo 混淆不能骗过（host=evil.example）
});

test('拒绝非 http(s) 协议与非法 URL', () => {
  assert.equal(isAllowedEgress('file:///etc/passwd', policy), false);
  assert.equal(isAllowedEgress('not-a-url', policy), false);
  assert.equal(isAllowedEgress('', policy), false);
});
