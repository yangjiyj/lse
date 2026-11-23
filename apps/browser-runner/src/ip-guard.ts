import dns from 'node:dns/promises';
import net from 'node:net';

export interface DnsResolver {
  lookup(hostname: string): Promise<string[]>;
}

export interface GuardDecision {
  allowed: boolean;
  reason?: string;
  pinnedIp?: string;
  hostname: string;
  addresses: string[];
}

export class SystemDnsResolver implements DnsResolver {
  async lookup(hostname: string): Promise<string[]> {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    return records.map((record) => record.address);
  }
}

const forbiddenV4Ranges: Array<[number, number, string]> = [
  [0x00000000, 0xff000000, '0.0.0.0/8'],
  [0x0a000000, 0xff000000, '10.0.0.0/8'],
  [0x7f000000, 0xff000000, '127.0.0.0/8'],
  [0xa9fe0000, 0xffff0000, '169.254.0.0/16'],
  [0xac100000, 0xfff00000, '172.16.0.0/12'],
  [0xc0a80000, 0xffff0000, '192.168.0.0/16'],
];

const forbiddenV6Ranges: Array<[bigint, number, string]> = [
  [0n, 128, '::/128'],
  [1n, 128, '::1/128'],
  [parseIpv6Full('fe80::'), 10, 'fe80::/10'],
  [parseIpv6Full('fc00::'), 7, 'fc00::/7'],
  [parseIpv6Full('ff00::'), 8, 'ff00::/8'],
];

export function normalizeIp(input: string): string | null {
  const host = trimIpBrackets(input.trim()).toLowerCase();
  const v4 = parseIPv4Like(host);
  if (v4 !== null) return intToIPv4(v4);

  const mapped = extractIPv4Mapped(host);
  if (mapped) return mapped;

  if (net.isIP(host) === 6) {
    const v6 = parseIpv6Full(host);
    const low32 = Number(v6 & 0xffffffffn);
    if (v6 >> 32n === 0xffffn) return intToIPv4(low32);
    if (v6 >> 32n === 0n) return intToIPv4(low32);
    return host;
  }
  return null;
}

export function isForbiddenIp(input: string): {
  forbidden: boolean;
  reason?: string;
  normalized?: string;
} {
  const normalized = normalizeIp(input);
  if (!normalized) return { forbidden: false };
  const v4 = parseIPv4Like(normalized);
  if (v4 !== null) {
    for (const [network, mask, reason] of forbiddenV4Ranges) {
      if ((v4 & mask) >>> 0 === network) return { forbidden: true, reason, normalized };
    }
    return { forbidden: false, normalized };
  }
  const v6 = parseIpv6Full(normalized);
  for (const [network, prefixLength, reason] of forbiddenV6Ranges) {
    const shift = BigInt(128 - prefixLength);
    if (v6 >> shift === network >> shift) return { forbidden: true, reason, normalized };
  }
  return { forbidden: false, normalized };
}

export async function validateAndPinUrl(
  urlText: string,
  resolver: DnsResolver,
): Promise<GuardDecision> {
  const url = new URL(urlText);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      allowed: false,
      reason: `unsupported_protocol:${url.protocol}`,
      hostname: url.hostname,
      addresses: [],
    };
  }

  const hostname = trimIpBrackets(url.hostname);
  const literal = normalizeIp(hostname);
  const addresses = literal ? [literal] : await resolver.lookup(hostname);
  if (addresses.length === 0) {
    return { allowed: false, reason: 'dns_empty', hostname, addresses: [] };
  }

  for (const address of addresses) {
    const verdict = isForbiddenIp(address);
    if (verdict.forbidden) {
      return {
        allowed: false,
        reason: `forbidden_ip:${verdict.reason}`,
        hostname,
        addresses,
      };
    }
  }

  return {
    allowed: true,
    hostname,
    addresses,
    pinnedIp: normalizeIp(addresses[0] ?? '') ?? addresses[0],
  };
}

export function buildPinnedUrl(
  originalUrl: string,
  pinnedIp: string,
): { url: string; hostHeader: string } {
  const url = new URL(originalUrl);
  const originalHost = url.host;
  const normalized = normalizeIp(pinnedIp) ?? pinnedIp;
  url.hostname = net.isIP(normalized) === 6 ? `[${normalized}]` : normalized;
  return { url: url.toString(), hostHeader: originalHost };
}

function trimIpBrackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function parseIPv4Like(input: string): number | null {
  if (input.length === 0 || input.includes(':')) return null;
  const parts = input.split('.');
  if (parts.length > 4) return null;
  const values = parts.map(parseIPv4Part);
  if (values.some((value) => value === null)) return null;
  const nums = values as number[];
  let result: number;
  if (nums.length === 1) {
    if (nums[0]! > 0xffffffff) return null;
    result = nums[0]!;
  } else if (nums.length === 2) {
    if (nums[0]! > 0xff || nums[1]! > 0xffffff) return null;
    result = (nums[0]! << 24) | nums[1]!;
  } else if (nums.length === 3) {
    if (nums[0]! > 0xff || nums[1]! > 0xff || nums[2]! > 0xffff) return null;
    result = (nums[0]! << 24) | (nums[1]! << 16) | nums[2]!;
  } else {
    if (nums.some((value) => value > 0xff)) return null;
    result = (nums[0]! << 24) | (nums[1]! << 16) | (nums[2]! << 8) | nums[3]!;
  }
  return result >>> 0;
}

function parseIPv4Part(input: string): number | null {
  if (!/^[+-]?(?:0x[0-9a-f]+|0[0-7]*|[0-9]+)$/i.test(input)) return null;
  if (input.startsWith('-') || input.startsWith('+')) return null;
  const radix = /^0x/i.test(input) ? 16 : input.length > 1 && input.startsWith('0') ? 8 : 10;
  const value = Number.parseInt(input, radix);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

function extractIPv4Mapped(input: string): string | null {
  const lower = input.toLowerCase();
  if (lower.startsWith('::ffff:')) {
    const tail = lower.slice('::ffff:'.length);
    const parsed = parseIPv4Like(tail);
    if (parsed !== null) return intToIPv4(parsed);
  }
  if (lower.startsWith('::')) {
    const tail = lower.slice(2);
    const parsed = parseIPv4Like(tail);
    if (parsed !== null) return intToIPv4(parsed);
  }
  return null;
}

function intToIPv4(value: number): string {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(
    '.',
  );
}

function parseIpv6Full(input: string): bigint {
  if (net.isIP(input) !== 6) throw new Error(`Invalid IPv6 address: ${input}`);
  const [headRaw, tailRaw] = input.toLowerCase().split('::') as [string, string?];
  const head = headRaw ? headRaw.split(':').filter(Boolean) : [];
  const tail = tailRaw ? tailRaw.split(':').filter(Boolean) : [];
  const missing = 8 - head.length - tail.length;
  const groups = [...head, ...Array.from({ length: Math.max(missing, 0) }, () => '0'), ...tail];
  return groups.reduce((acc, group) => (acc << 16n) + BigInt(Number.parseInt(group, 16)), 0n);
}
