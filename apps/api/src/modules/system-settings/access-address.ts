import { isIP } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';

// 只接受单个合法 authority，拒绝用户信息、路径、列表、空白和 HTML 字符。
function hostname(authority: string): string | null {
  if (!authority || authority.length > 260 || /[\s,/@\\?#<>%]/.test(authority)) return null;
  try {
    const parsed = new URL(`http://${authority}`);
    const host = parsed.hostname;
    if (host.startsWith('[')) return isIP(host.slice(1, -1)) === 6 ? host : null;
    if (host.length > 253 || !host.split('.').every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return null;
    return host;
  } catch {
    return null;
  }
}

export function requestLoginAddresses(headers: IncomingHttpHeaders) {
  let authority = headers['x-forwarded-host'] ?? headers.host;
  if (authority === undefined && typeof headers.origin === 'string') {
    try {
      const origin = new URL(headers.origin);
      if (['http:', 'https:'].includes(origin.protocol) && origin.origin === headers.origin) {
        authority = origin.host;
      }
    } catch { /* 无法推导时保持未配置 */ }
  }
  const host = typeof authority === 'string' ? hostname(authority) : null;
  return {
    encryptedLoginUrl: host ? `https://${host}:10443/login` : '',
    compatibleLoginUrl: host ? `http://${host}:8090/login` : '',
  };
}
