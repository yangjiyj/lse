import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isForbiddenIp,
  normalizeIp,
  validateAndPinUrl,
  type DnsResolver,
} from '../src/ip-guard.js';

class MockResolver implements DnsResolver {
  constructor(private readonly records: Record<string, string[]>) {}
  async lookup(hostname: string): Promise<string[]> {
    return this.records[hostname] ?? [];
  }
}

test('normalizes decimal octal hex and mapped IPv6 forms before blocking', () => {
  assert.equal(normalizeIp('2852039166'), '169.254.169.254');
  assert.equal(normalizeIp('0251.0376.0251.0376'), '169.254.169.254');
  assert.equal(normalizeIp('0xa9.0xfe.0xa9.0xfe'), '169.254.169.254');
  assert.equal(normalizeIp('::ffff:169.254.169.254'), '169.254.169.254');

  for (const value of [
    '169.254.169.254',
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '0.0.0.0',
    '2852039166',
    '::ffff:169.254.169.254',
    '::1',
    'fe80::1',
    'fc00::1',
    'ff00::1',
  ]) {
    assert.equal(isForbiddenIp(value).forbidden, true, value);
  }
});

test('validateAndPinUrl rejects if any DNS answer is forbidden', async () => {
  const resolver = new MockResolver({
    'rebind.test': ['93.184.216.34', '169.254.169.254'],
    'public.test': ['93.184.216.34'],
  });

  const blocked = await validateAndPinUrl('http://rebind.test/path', resolver);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason ?? '', /forbidden_ip/);

  const allowed = await validateAndPinUrl('http://public.test/path', resolver);
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.pinnedIp, '93.184.216.34');
});

test('validateAndPinUrl blocks a TTL-zero rebinding resolver on the second request', async () => {
  let calls = 0;
  const resolver: DnsResolver = {
    async lookup() {
      calls += 1;
      return calls === 1 ? ['93.184.216.34'] : ['169.254.169.254'];
    },
  };

  const first = await validateAndPinUrl('http://ttl0.test/chat', resolver);
  assert.equal(first.allowed, true);
  assert.equal(first.pinnedIp, '93.184.216.34');

  const second = await validateAndPinUrl('http://ttl0.test/script.js', resolver);
  assert.equal(second.allowed, false);
  assert.match(second.reason ?? '', /forbidden_ip/);
});
