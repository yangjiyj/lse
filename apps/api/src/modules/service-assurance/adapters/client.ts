export type ScannerClientErrorCode =
  | 'SERVICE_ASSURANCE_SIDECAR_CONFIG_INVALID'
  | 'SERVICE_ASSURANCE_SIDECAR_UNAVAILABLE'
  | 'SERVICE_ASSURANCE_SIDECAR_TIMEOUT'
  | 'SERVICE_ASSURANCE_SIDECAR_REDIRECT'
  | 'SERVICE_ASSURANCE_SIDECAR_REJECTED'
  | 'SERVICE_ASSURANCE_SIDECAR_RESPONSE_TOO_LARGE'
  | 'SERVICE_ASSURANCE_SIDECAR_RESPONSE_INVALID'
  | 'SERVICE_ASSURANCE_SIDECAR_BASELINE_MISMATCH';

const ERROR_MESSAGE: Record<ScannerClientErrorCode, string> = {
  SERVICE_ASSURANCE_SIDECAR_CONFIG_INVALID: '安全核验服务配置无效。',
  SERVICE_ASSURANCE_SIDECAR_UNAVAILABLE: '安全核验服务暂不可用。',
  SERVICE_ASSURANCE_SIDECAR_TIMEOUT: '安全核验服务响应超时。',
  SERVICE_ASSURANCE_SIDECAR_REDIRECT: '安全核验服务返回了不允许的重定向。',
  SERVICE_ASSURANCE_SIDECAR_REJECTED: '安全核验服务拒绝了本次请求。',
  SERVICE_ASSURANCE_SIDECAR_RESPONSE_TOO_LARGE: '安全核验服务返回内容超过限制。',
  SERVICE_ASSURANCE_SIDECAR_RESPONSE_INVALID: '安全核验服务返回格式无效。',
  SERVICE_ASSURANCE_SIDECAR_BASELINE_MISMATCH: '安全核验服务基线与平台固定版本不一致。',
};

export class ScannerClientError extends Error {
  constructor(readonly code: ScannerClientErrorCode) {
    super(ERROR_MESSAGE[code]);
    this.name = 'ScannerClientError';
  }
}

export interface ScannerJsonRequestOptions {
  baseUrl: string;
  path: `/${string}`;
  method: 'GET' | 'POST';
  body?: unknown;
  timeoutMs: number;
  maxResponseBytes: number;
  fetchImpl?: typeof fetch;
}

function scannerEndpoint(baseUrl: string, path: `/${string}`): URL {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new ScannerClientError('SERVICE_ASSURANCE_SIDECAR_CONFIG_INVALID');
  }
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new ScannerClientError('SERVICE_ASSURANCE_SIDECAR_CONFIG_INVALID');
  }
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/`;
  return new URL(path.replace(/^\/+/, ''), base);
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ScannerClientError('SERVICE_ASSURANCE_SIDECAR_RESPONSE_TOO_LARGE');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ScannerClientError('SERVICE_ASSURANCE_SIDECAR_RESPONSE_TOO_LARGE');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export async function requestScannerJson(options: ScannerJsonRequestOptions): Promise<unknown> {
  const endpoint = scannerEndpoint(options.baseUrl, options.path);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    let response: Response;
    try {
      response = await (options.fetchImpl ?? fetch)(endpoint, {
        method: options.method,
        headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch {
      throw new ScannerClientError(
        controller.signal.aborted
          ? 'SERVICE_ASSURANCE_SIDECAR_TIMEOUT'
          : 'SERVICE_ASSURANCE_SIDECAR_UNAVAILABLE',
      );
    }
    if (response.status >= 300 && response.status < 400) {
      throw new ScannerClientError('SERVICE_ASSURANCE_SIDECAR_REDIRECT');
    }
    if (!response.ok) throw new ScannerClientError('SERVICE_ASSURANCE_SIDECAR_REJECTED');
    const contentType = response.headers.get('content-type') ?? '';
    if (!/^application\/(?:[A-Za-z0-9.+-]*\+)?json\b/i.test(contentType)) {
      throw new ScannerClientError('SERVICE_ASSURANCE_SIDECAR_RESPONSE_INVALID');
    }
    const body = await readLimited(response, options.maxResponseBytes);
    try {
      return JSON.parse(body);
    } catch {
      throw new ScannerClientError('SERVICE_ASSURANCE_SIDECAR_RESPONSE_INVALID');
    }
  } finally {
    clearTimeout(timer);
  }
}
