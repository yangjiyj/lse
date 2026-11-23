// 文件下载的附件响应头：报告下载、列表导出、样本库导出共用。
import type { FastifyReply } from 'fastify';

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Unicode 双向控制符：能把「fdp.exe」显示成「exe.pdf」，文件名里一律去掉。 */
export const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g;

/**
 * Content-Disposition：filename 给 ASCII 兜底名，filename* 给 UTF-8 原名（RFC 5987）。
 * 文件名里的路径分隔符、保留字符和控制字符换成空格，双向控制符去掉；清理后为空时用兜底名。
 * 没给兜底名时，纯 ASCII 文件名直接兜底，否则用 download.<扩展名>；
 * 扩展名从清理后的名字取，只认 1～10 位字母数字，否则用 bin（防止引号、分号拼进响应头）。
 */
export function attachmentDisposition(filename: string, fallbackName?: string): string {
  const safeName = filename
    .replace(BIDI_CONTROLS, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .trim();
  const ext = /\.([A-Za-z0-9]{1,10})$/.exec(safeName)?.[1] ?? 'bin';
  const name = safeName || fallbackName || `download.${ext}`;
  const fallback =
    fallbackName ?? (/^[\x20-\x7e]+$/.test(name) ? name.replace(/["\\]/g, '') : `download.${ext}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}

/** 作为附件下载：ASCII 文件名兜底 + UTF-8 中文文件名。 */
export function sendAttachment(
  reply: FastifyReply,
  body: Buffer | string,
  opts: { contentType: string; filename: string; fallbackName: string },
): FastifyReply {
  reply.header('Content-Disposition', attachmentDisposition(opts.filename, opts.fallbackName));
  reply.type(opts.contentType);
  // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write -- file download, not HTML rendering.
  return reply.send(body);
}
