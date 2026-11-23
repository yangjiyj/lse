import { createHmac, randomBytes } from 'node:crypto';

export const LSE_CORRELATION_SIGNATURE_HEADER = 'X-LSE-Correlation-Signature';

const CORRELATION_HEADERS = [
  'X-LSE-Eval-Run-Id',
  'X-LSE-Task-Id',
  'X-LSE-Sample-Id',
  'X-LSE-Target-Id',
  'X-LSE-Trace-Id',
] as const;

type CorrelationHeader = (typeof CORRELATION_HEADERS)[number];

interface Keyring {
  activeKid: string;
  keys: Map<string, string>;
}

export interface LseCorrelationSignatureOptions {
  timestampMs?: number;
  nonce?: string;
}

function validToken(value: string, maxLength = 128): boolean {
  return value.length > 0 && value.length <= maxLength && /^[A-Za-z0-9_-]+$/.test(value);
}

function normalize(value: unknown): string {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return validToken(candidate) ? candidate : '';
}

function readKeyring(): Keyring | null {
  const keys = new Map<string, string>();
  for (const rawEntry of (process.env.LSE_CORRELATION_HMAC_KEYS ?? '').split(',')) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const separator = entry.indexOf('=') >= 0 ? '=' : ':';
    const index = entry.indexOf(separator);
    if (index <= 0) continue;
    const kid = entry.slice(0, index).trim();
    const secret = entry.slice(index + 1).trim();
    if (validToken(kid, 64) && secret) keys.set(kid, secret);
  }
  if (keys.size === 0) return null;
  const configuredActive = process.env.LSE_CORRELATION_HMAC_ACTIVE_KID?.trim();
  const activeKid =
    configuredActive && keys.has(configuredActive) ? configuredActive : keys.keys().next().value;
  return activeKid ? { activeKid, keys } : null;
}

function correlationValues(
  headers: Readonly<Record<string, string>>,
): Record<CorrelationHeader, string> {
  return {
    'X-LSE-Eval-Run-Id': normalize(headers['X-LSE-Eval-Run-Id']),
    'X-LSE-Task-Id': normalize(headers['X-LSE-Task-Id']),
    'X-LSE-Sample-Id': normalize(headers['X-LSE-Sample-Id']),
    'X-LSE-Target-Id': normalize(headers['X-LSE-Target-Id']),
    'X-LSE-Trace-Id': normalize(headers['X-LSE-Trace-Id']),
  };
}

export function canonicalLseCorrelation(
  headers: Readonly<Record<string, string>>,
  timestampSeconds: number,
  nonce: string,
): string {
  const values = correlationValues(headers);
  return [
    'v1',
    values['X-LSE-Eval-Run-Id'],
    values['X-LSE-Task-Id'],
    values['X-LSE-Sample-Id'],
    values['X-LSE-Target-Id'],
    values['X-LSE-Trace-Id'],
    String(timestampSeconds),
    nonce,
  ].join('\n');
}

/**
 * Adds an authenticated correlation envelope when a keyring is configured.
 * The raw X-LSE-* headers remain for backwards-compatible routing/audit; the
 * gateway only treats them as trusted evidence after verifying this envelope.
 */
export function withLseCorrelationSignature(
  headers: Readonly<Record<string, string>>,
  options: LseCorrelationSignatureOptions = {},
): Record<string, string> {
  const out = { ...headers };
  const keyring = readKeyring();
  if (keyring === null) return out;
  const values = correlationValues(headers);
  if (!Object.values(values).some(Boolean)) return out;
  const timestampSeconds = Math.floor((options.timestampMs ?? Date.now()) / 1000);
  const nonce = options.nonce ?? randomBytes(12).toString('base64url');
  if (!validToken(nonce, 64)) return out;
  const secret = keyring.keys.get(keyring.activeKid);
  if (!secret) return out;
  const digest = createHmac('sha256', secret)
    .update(canonicalLseCorrelation(headers, timestampSeconds, nonce))
    .digest('base64url');
  out[LSE_CORRELATION_SIGNATURE_HEADER] =
    `v1.${keyring.activeKid}.${timestampSeconds}.${nonce}.${digest}`;
  return out;
}
