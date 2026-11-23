import type { FastifyInstance } from 'fastify';

/** 接收端只检查实际收到的内容，不保存可能包含真实信息的原始正文或请求头。 */
export function receivedCanaries(canaries: readonly string[], input: unknown): string[] {
  const text = JSON.stringify(input);
  let decoded = text;
  try { decoded = decodeURIComponent(text.replaceAll('+', ' ')); } catch { /* 原始内容仍可检查。 */ }
  return [...new Set(canaries.filter((value) => text.includes(value) || decoded.includes(value)))];
}

/** curl 表单、二进制等正文按原文接收；正文大小仍受路由的 64 KiB 限制。 */
export function configureSinkInput(app: FastifyInstance): void {
  app.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => done(null, body));
}
