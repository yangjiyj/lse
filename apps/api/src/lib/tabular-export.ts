// 列表类导出（CSV / JSON）共用：行数上限、CSV 拼装（UTF-8 BOM + 下载水印行、防公式注入）、北京时间。
// 附件响应头见 attachment.ts。
import { badRequest } from './errors.js';
import { csvWatermarkLine, type DownloadWatermark } from './data-security.js';

/** 单次导出的行数上限。 */
export const EXPORT_ROW_LIMIT = 50_000;

/** 超过单次导出上限时返回 400；hint 是给用户的缩小办法。 */
export function assertExportSize(count: number, hint = '请缩小范围'): void {
  if (count > EXPORT_ROW_LIMIT) {
    throw badRequest(`导出超过 ${EXPORT_ROW_LIMIT} 行，${hint}`, 'EXPORT_TOO_LARGE', {
      count,
      limit: EXPORT_ROW_LIMIT,
    });
  }
}

const exportTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** 导出文件里的时间统一写北京时间 `YYYY-MM-DD HH:mm:ss`。 */
export function exportTime(d: Date | null | undefined): string {
  if (!d || !Number.isFinite(d.getTime())) return '';
  const p = Object.fromEntries(exportTimeFormatter.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

export type CsvValue = string | number | boolean | null | undefined;

/** Excel 会把这些字符开头的单元格当公式执行（CSV 公式注入）。 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/** 文本以公式触发字符开头时前面加 `'`，Excel 打开当文本显示。 */
export function neutralizeFormula(value: string): string {
  return FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}

/** 导入时还原：`'` 后紧跟公式触发字符才去掉这个 `'`（与 neutralizeFormula 往返一致）。 */
export function restoreFormula(value: string): string {
  return value.startsWith("'") && FORMULA_TRIGGER.test(value.slice(1)) ? value.slice(1) : value;
}

/** CSV 单元格：字符串防公式注入（数字等非字符串不处理），含逗号、引号、换行时加引号。 */
export function csvCell(value: CsvValue): string {
  const s =
    value == null ? '' : typeof value === 'string' ? neutralizeFormula(value) : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 一行 CSV（不含换行）。 */
export function csvRow(row: CsvValue[]): string {
  return row.map(csvCell).join(',');
}

/** 已拼好的数据行 → CSV 文件：UTF-8 BOM、开启下载水印时首行是水印、CRLF 换行。 */
export function csvFile(
  header: string[],
  lines: string[],
  watermark?: DownloadWatermark | null,
): Buffer {
  const all = [csvRow(header), ...lines];
  if (watermark) all.unshift(csvWatermarkLine(watermark));
  return Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(all.join('\r\n') + '\r\n', 'utf8'),
  ]);
}

/** CSV：UTF-8 BOM（Excel 打开不乱码）；开启下载水印时首行是水印，导入解析会跳过它。 */
export function buildCsv(
  header: string[],
  rows: CsvValue[][],
  watermark?: DownloadWatermark | null,
): Buffer {
  return csvFile(header, rows.map(csvRow), watermark);
}
