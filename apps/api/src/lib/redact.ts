import { createHash } from 'node:crypto';

export const SENSITIVE_KEY_RE =
  /(authorization|token|secret|key|password|canary|api[_-]?key|cookie|set-cookie|jwt|credential|cred|session|sessionid|passphrase|bearer)/i;
export const RAW_DETAIL_KEY_RE = /^(rawArguments|rawArgument|raw|rawOutput)$/i;
export const AUTH_BEARER_RE = /Authorization:\s*Bearer\s+([^\s,;]+)/gi;
export const BEARER_RE = /Bearer\s+([^\s,;]+)/gi;
export const EMBEDDED_URL_CREDENTIAL_RE = /(\b[a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi;
const PEM_BEGIN_PREFIX = '-----BEGIN ';
const PEM_PRIVATE_KEY_LABELS = [
  'PRIVATE KEY',
  'RSA PRIVATE KEY',
  'EC PRIVATE KEY',
  'DSA PRIVATE KEY',
  'OPENSSH PRIVATE KEY',
  'ENCRYPTED PRIVATE KEY',
] as const;

interface PemPrivateKeyStart {
  index: number;
  beginMarker: string;
  endMarker: string;
}

function findPemPrivateKeyStart(value: string, fromIndex: number): PemPrivateKeyStart | null {
  let searchFrom = fromIndex;
  while (searchFrom < value.length) {
    const index = value.indexOf(PEM_BEGIN_PREFIX, searchFrom);
    if (index === -1) return null;

    for (const label of PEM_PRIVATE_KEY_LABELS) {
      const beginMarker = `${PEM_BEGIN_PREFIX}${label}-----`;
      if (value.startsWith(beginMarker, index)) {
        return {
          index,
          beginMarker,
          endMarker: `-----END ${label}-----`,
        };
      }
    }

    searchFrom = index + PEM_BEGIN_PREFIX.length;
  }
  return null;
}

/**
 * 线性扫描 PEM 私钥块。遇到合法 BEGIN 但没有对应 END 时，
 * 从 BEGIN 到文本末尾一并遮蔽，避免未闭合敏感块残留在报告中。
 */
function redactPemPrivateKeys(value: string): string {
  if (!value.includes(PEM_BEGIN_PREFIX)) return value;

  const parts: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const start = findPemPrivateKeyStart(value, cursor);
    if (!start) {
      parts.push(value.slice(cursor));
      break;
    }

    parts.push(value.slice(cursor, start.index));
    const contentStart = start.index + start.beginMarker.length;
    const endIndex = value.indexOf(start.endMarker, contentStart);
    if (endIndex === -1) {
      parts.push(hashSensitive(value.slice(start.index)));
      cursor = value.length;
      break;
    }

    const afterEnd = endIndex + start.endMarker.length;
    parts.push(hashSensitive(value.slice(start.index, afterEnd)));
    cursor = afterEnd;
  }

  return parts.join('');
}
export const SECRET_VALUE_RE =
  /\b(?:sk-[a-z0-9_-]+|tok-[a-z0-9_-]+|canary-[a-z0-9_-]+|CANARY[-_A-Z0-9]+|AIza[A-Za-z0-9_-]{35}|(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b|(?:eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)|(?:Basic\s+[A-Za-z0-9+/]{20,}={0,2})/gi;
export const SENSITIVE_LABEL_VALUE_RE =
  /\b(authorization|token|secret|password|canary|api[_\s-]*key|key)\b(\s*[:=]\s*|\s+)([^\s,;]+)/gi;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hashSensitive(value: string): string {
  if (/^hash:[0-9a-f]{12}$/i.test(value)) return value;
  return `hash:${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
}

export function redactString(value: string, key = ''): string {
  if (SENSITIVE_KEY_RE.test(key)) return hashSensitive(value);
  try {
    const url = new URL(value);
    if (url.password) {
      return value.replace(
        /(\/\/[^:/?#]+:)([^@]+)@/,
        (_match, prefix: string, password: string) => `${prefix}${hashSensitive(password)}@`,
      );
    }
  } catch {
    // Not a standalone URL; continue with token pattern redaction.
  }
  let redacted = value.replace(
    EMBEDDED_URL_CREDENTIAL_RE,
    (_match, prefix: string, password: string, suffix: string) =>
      `${prefix}${hashSensitive(password)}${suffix}`,
  );
  redacted = redactPemPrivateKeys(redacted);
  redacted = redacted.replace(AUTH_BEARER_RE, (_match, secret: string) => {
    return `Authorization: ${hashSensitive(secret)}`;
  });
  redacted = redacted.replace(BEARER_RE, (_match, secret: string) => {
    return `Bearer ${hashSensitive(secret)}`;
  });
  redacted = redacted.replace(SECRET_VALUE_RE, (secret) => hashSensitive(secret));
  redacted = redacted.replace(
    SENSITIVE_LABEL_VALUE_RE,
    (match, label: string, separator: string, secret: string) => {
      if (secret.startsWith('hash:')) return match;
      const normalizedLabel = label.toLowerCase().replace(/[\s_-]+/g, '');
      const bareSeparatorAllowed = ['secret', 'password', 'canary', 'apikey'].includes(
        normalizedLabel,
      );
      if (/^\s+$/.test(separator) && !bareSeparatorAllowed) return match;
      return `${label}${separator}${hashSensitive(secret)}`;
    },
  );
  return redacted;
}

/**
 * sanitizeJson —— 用于「详情/证据」类输出：除按 key/value 脱敏外，
 * 还会 **丢弃** 原始大字段（rawArguments / raw / rawOutput 等），避免原文直出。
 */
export function sanitizeJson(value: unknown, key = ''): unknown {
  if (typeof value === 'string') return redactString(value, key);
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, key));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      if (RAW_DETAIL_KEY_RE.test(childKey)) continue;
      out[childKey] = sanitizeJson(childValue, childKey);
    }
    return out;
  }
  return value;
}

/**
 * redactJson —— 用于「配置/透传」类输出（extraHeaders / accessConfig / 指标关联）：
 * **保留所有 key 与结构**，只把命中敏感 key 或敏感值的字符串替换为 hash:xxxx。
 * 与 sanitizeJson 的区别在于不丢弃任何字段，确保前端配置可见性不被破坏。
 */
export function redactJson(value: unknown, key = ''): unknown {
  if (typeof value === 'string') return redactString(value, key);
  if (Array.isArray(value)) return value.map((item) => redactJson(item, key));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = redactJson(childValue, childKey);
    }
    return out;
  }
  if (SENSITIVE_KEY_RE.test(key)) return hashSensitive(String(value));
  return value;
}
