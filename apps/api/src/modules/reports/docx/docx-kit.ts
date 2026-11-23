// Word 报告的排版积木：标题、段落、列表、表格、页眉页脚。通用报告和组合报告共用。
import {
  AlignmentType,
  Document,
  Footer,
  Header,
  HeadingLevel,
  Packer,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  TableLayoutType,
  WidthType,
  type FileChild,
} from 'docx';

export const DOCX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** A4 纵向、默认页边距下的正文宽度（twip）。 */
const TEXT_WIDTH = 9000;
const BODY_FONT = '宋体';
const HEADING_FONT = '黑体';
const BORDER = { style: 'single' as const, size: 4, color: '9AA7B5' };
const CELL_BORDERS = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };

// XML 1.0 不允许的控制字符和孤立代理项：模型输出里出现时 Word 会打不开文件。
// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** 去掉 XML 不允许的字符；尖括号、& 等由 docx 写 XML 时转义。 */
export function cleanText(value: unknown): string {
  return String(value ?? '')
    .replace(INVALID_XML_CHARS, '')
    .replace(LONE_SURROGATES, '');
}

/** 多行文字拆成带换行的文字段。 */
function runs(text: string, opts: { bold?: boolean; color?: string } = {}): TextRun[] {
  const lines = cleanText(text).replace(/\r\n?/g, '\n').split('\n');
  return lines.map(
    (line, i) =>
      new TextRun({
        text: line,
        ...(i > 0 ? { break: 1 } : {}),
        bold: opts.bold,
        color: opts.color,
      }),
  );
}

export function docTitle(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.TITLE,
    alignment: AlignmentType.CENTER,
    spacing: { before: 1200, after: 480 },
    children: runs(text),
  });
}

export function heading1(text: string): Paragraph {
  return new Paragraph({ heading: HeadingLevel.HEADING_1, keepNext: true, children: runs(text) });
}

export function heading2(text: string): Paragraph {
  return new Paragraph({ heading: HeadingLevel.HEADING_2, keepNext: true, children: runs(text) });
}

export function para(text: string, opts: { bold?: boolean; color?: string } = {}): Paragraph {
  return new Paragraph({ spacing: { after: 120 }, children: runs(text, opts) });
}

/** 「标签：内容」一行，标签加粗。 */
export function labelled(label: string, text: string): Paragraph {
  return new Paragraph({
    spacing: { after: 80 },
    children: [new TextRun({ text: `${cleanText(label)}：`, bold: true }), ...runs(text)],
  });
}

export function bullets(items: string[]): Paragraph[] {
  return items.map((item) => new Paragraph({ bullet: { level: 0 }, children: runs(item) }));
}

export function numbered(items: string[]): Paragraph[] {
  return items.map((item, i) => para(`${i + 1}. ${item}`));
}

function cell(text: string, header: boolean, width?: number): TableCell {
  return new TableCell({
    children: [new Paragraph({ children: runs(text, { bold: header }) })],
    borders: CELL_BORDERS,
    ...(header ? { shading: { fill: 'EDF4FB' } } : {}),
    ...(width ? { width: { size: width, type: WidthType.DXA } } : {}),
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
  });
}

/** 带表头的数据表；weights 为各列的相对宽度。 */
export function table(headers: string[], rows: string[][], weights?: number[]): Table {
  const w = weights ?? headers.map(() => 1);
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  const widths = w.map((x) => Math.round((x / sum) * TEXT_WIDTH));
  return new Table({
    width: { size: TEXT_WIDTH, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: widths,
    rows: [
      new TableRow({
        tableHeader: true,
        children: headers.map((h, i) => cell(h, true, widths[i])),
      }),
      ...rows.map(
        (r) =>
          new TableRow({ children: headers.map((_, i) => cell(r[i] ?? '', false, widths[i])) }),
      ),
    ],
  });
}

/** 两列键值表。 */
export function kvTable(rows: Array<{ k: string; v: string }>): Table {
  return new Table({
    width: { size: TEXT_WIDTH, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: [2400, TEXT_WIDTH - 2400],
    rows: rows.map(
      (r) =>
        new TableRow({ children: [cell(r.k, true, 2400), cell(r.v, false, TEXT_WIDTH - 2400)] }),
    ),
  });
}

/** 表格后留一点空白，避免和下一段贴在一起。 */
export function gap(): Paragraph {
  return new Paragraph({ spacing: { after: 120 }, children: [] });
}

export interface DocxPageOptions {
  /** 下载水印文字；有值时页眉页脚都写水印。 */
  watermark?: string | null;
  /** 不带水印时的页眉文字。 */
  headerText: string;
  /** 不带水印时页脚左侧的文字（如报告编号）。 */
  footerText: string;
}

/** 组装成 Word 文件。 */
export async function packDocx(
  title: string,
  children: FileChild[],
  page: DocxPageOptions,
): Promise<Buffer> {
  const wm = page.watermark ? cleanText(page.watermark) : '';
  const headerText = wm || cleanText(page.headerText);
  const footerLead = wm || cleanText(page.footerText);
  const document = new Document({
    title: cleanText(title),
    styles: {
      default: {
        document: { run: { font: BODY_FONT, size: 21 } },
        title: { run: { font: HEADING_FONT, size: 40, bold: true, color: '123B68' } },
        heading1: {
          run: { font: HEADING_FONT, size: 30, bold: true, color: '123B68' },
          paragraph: { spacing: { before: 360, after: 160 } },
        },
        heading2: {
          run: { font: HEADING_FONT, size: 24, bold: true, color: '175A96' },
          paragraph: { spacing: { before: 240, after: 120 } },
        },
      },
    },
    sections: [
      {
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: headerText, size: 16, color: '74808E' })],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: `${footerLead}　第 `, size: 16, color: '74808E' }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '74808E' }),
                  new TextRun({ text: ' 页 共 ', size: 16, color: '74808E' }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: '74808E' }),
                  new TextRun({ text: ' 页', size: 16, color: '74808E' }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(document);
}
