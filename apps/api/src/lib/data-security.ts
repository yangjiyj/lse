import type ExcelJS from 'exceljs';
import { z } from 'zod';
import { prisma } from '../db.js';
import { writeAudit } from './audit.js';
import type { CurrentUser } from './rbac.js';
import { DEFAULT_PLATFORM_TITLE_TEXT } from './product-name.js';
import { TENANT_SETTING_KEY, parseStoredTenant } from './tenant-branding.js';

/**
 * 数据安全（systemSetting key = 'data_security'）：
 * 前端敏感个人信息默认脱敏、下载文件添加水印、前端页面水印层。各开关默认开启。
 * 下载日志不设开关，始终记录，用于审计。
 */
export const DATA_SECURITY_SETTING_KEY = 'data_security';

export const dataSecuritySchema = z.object({
  maskSensitive: z.boolean(),
  downloadWatermark: z.boolean(),
  pageWatermark: z.boolean(),
});

export type DataSecuritySettings = z.infer<typeof dataSecuritySchema>;

export const DEFAULT_DATA_SECURITY_SETTINGS: DataSecuritySettings = {
  maskSensitive: true,
  downloadWatermark: true,
  pageWatermark: true,
};

export function parseStoredDataSecurity(value: unknown): DataSecuritySettings {
  const stored = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const parsed = dataSecuritySchema.safeParse({ ...DEFAULT_DATA_SECURITY_SETTINGS, ...stored });
  return parsed.success ? parsed.data : DEFAULT_DATA_SECURITY_SETTINGS;
}

export async function loadDataSecurity(): Promise<DataSecuritySettings> {
  const row = await prisma.systemSetting.findUnique({ where: { key: DATA_SECURITY_SETTING_KEY } });
  return parseStoredDataSecurity(row?.value);
}

export interface DownloadWatermark {
  /** 单行水印文本：平台标题 下载人 时间 */
  text: string;
  platformTitle: string;
  downloader: string;
  downloadedAt: string;
}

function formatTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 构造下载水印（下载人 + 时间 + 平台标题）；数据安全关闭下载水印时返回 null。 */
export async function resolveDownloadWatermark(
  user: Pick<CurrentUser, 'username'> & { displayName?: string | null },
  now: Date = new Date(),
): Promise<DownloadWatermark | null> {
  const settings = await loadDataSecurity();
  if (!settings.downloadWatermark) return null;
  const tenantRow = await prisma.systemSetting.findUnique({ where: { key: TENANT_SETTING_KEY } });
  const platformTitle = parseStoredTenant(tenantRow?.value).platformTitle;
  const downloader = user.displayName ? `${user.displayName}(${user.username})` : user.username;
  const downloadedAt = formatTime(now);
  return {
    text: `${platformTitle} ${downloader} ${downloadedAt}`,
    platformTitle,
    downloader,
    downloadedAt,
  };
}

/** 文本类文件（md/txt/csv）的水印头行。 */
export function textWatermarkHeader(wm: DownloadWatermark, commentPrefix = '#'): string {
  return `${commentPrefix} 水印：${wm.text}\n`;
}

/** 下载日志：所有文件下载统一使用 `download.*` 前缀，便于操作日志按“下载”筛选。 */
export async function auditDownload(
  user: Pick<CurrentUser, 'id' | 'username'>,
  input: { kind: string; targetType: string; targetId?: string | null; detail?: unknown },
  request?: { ip?: string; headers?: { 'user-agent'?: string } },
): Promise<void> {
  const ua = request?.headers?.['user-agent'];
  await writeAudit({
    actorId: user.id,
    actorName: user.username,
    action: `download.${input.kind}`,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    ip: request?.ip ?? null,
    userAgent: typeof ua === 'string' ? ua : null,
    detail: input.detail,
  });
}

/** CSS 字符串字面量转义：防止标题/用户名中的引号、反斜杠或 `<` 闭合样式块。 */
function cssString(text: string): string {
  return '"' + text.replace(/[\\"<>\r\n]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `) + '"';
}

/** 屏幕水印文字：重复多份铺满；每份内的空格换成不换行空格，换行只落在两份之间。 */
function screenWatermarkContent(text: string): string {
  const copy = text.replace(/ /g, '\u00a0');
  return cssString(Array.from({ length: 60 }, () => copy).join('\u3000\u3000 '));
}

/**
 * HTML(chromium + paged.js) 报告水印：每页底部中间页脚改为水印文本，并在每页叠加斜向浅色水印。
 * 斜向水印是不换行的长文本，会伸出页面右边；必须在页面内裁掉（overflow:hidden），
 * 否则文档宽度超过页宽，Chrome 打印时整页「缩小以适应」，PDF 右侧、底部留白，封面也铺不满。
 */
export function applyHtmlWatermark(html: string, wm: DownloadWatermark): string {
  const content = cssString(wm.text);
  const withFooter = html.replace(
    `text-align:center; content:"${DEFAULT_PLATFORM_TITLE_TEXT}";`,
    `text-align:center; content:${content};`,
  );
  const style =
    `<style>.pagedjs_page{position:relative;overflow:hidden;}` +
    `.pagedjs_page::after{content:${content};position:absolute;left:0;right:0;top:46%;` +
    `text-align:center;transform:rotate(-30deg);font-size:26pt;color:rgba(100,116,139,0.14);` +
    `pointer-events:none;z-index:9999;white-space:nowrap;}` +
    // 浏览器里直接打开下载的 HTML 也能看到水印：铺满视口、半透明、不挡点击。
    // 只在屏幕媒体生效，PDF 按打印媒体渲染，不受影响。
    `@media screen{body::after{content:${screenWatermarkContent(wm.text)};position:fixed;` +
    `top:-50vh;left:-50vw;width:200vw;height:200vh;display:flex;align-items:center;` +
    `justify-content:center;text-align:center;transform:rotate(-30deg);font-size:14px;` +
    `line-height:120px;color:rgba(100,116,139,0.12);pointer-events:none;z-index:2147483647;` +
    `overflow:hidden;white-space:normal;}}</style>`;
  return withFooter.includes('</head>')
    ? withFooter.replace('</head>', `${style}</head>`)
    : `${style}${withFooter}`;
}

/** exceljs 页眉/页脚水印（打印与页面布局视图可见）。`&` 在页眉语法中需写成 `&&`。 */
export function applyWorkbookWatermark(wb: ExcelJS.Workbook, wm: DownloadWatermark): void {
  const safe = wm.text.replace(/&/g, '&&');
  for (const ws of wb.worksheets) {
    ws.headerFooter.oddHeader = `&C${safe}`;
    ws.headerFooter.evenHeader = `&C${safe}`;
    ws.headerFooter.oddFooter = `&L${safe}&R第 &P / &N 页`;
    ws.headerFooter.evenFooter = `&L${safe}&R第 &P / &N 页`;
  }
  wb.subject = `水印：${wm.text}`;
}

/** CSV 首行水印；导入解析时由 stripCsvWatermark 去掉，保证模板仍可直接回填导入。 */
export const CSV_WATERMARK_PREFIX = '# 水印：';

export function csvWatermarkLine(wm: DownloadWatermark): string {
  const cell = `${CSV_WATERMARK_PREFIX}${wm.text}`;
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}
