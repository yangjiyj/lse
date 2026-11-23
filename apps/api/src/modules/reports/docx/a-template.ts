import { Document, Footer, Header, PageNumber, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';

export type ATemplateInfo = { platformName: string; reportNo: string; subject: string; basis: string; period: string; organization: string };
export type ATemplateOptions = { unmetItems?: string[]; conclusion?: string; title?: string };
export type ATemplateSection = { title: string; body: string; table?: { headers: string[]; rows: string[][] } };

export async function createATemplate(info: ATemplateInfo, sections: ATemplateSection[], options: ATemplateOptions = {}): Promise<Buffer> {
  const border = { style: 'single' as const, size: 1, color: '666666' };
  const cell = (text: string, header = false) => new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text, bold: header, font: header ? '黑体' : '宋体' })] })],
    shading: header ? { fill: 'E7E7E7' } : undefined,
    borders: { top: border, bottom: border, left: border, right: border },
  });
  const rows: [string, string][] = [
    ['被测对象', info.subject], ['评估依据', info.basis], ['评估周期', info.period],
    ['评估单位', info.organization], ['编制 / 审核 / 批准', '编制：________  审核：________  批准：________'],
  ];
  const unmet = options.unmetItems ?? [];
  const body = [
    new Paragraph({ text: options.title ?? '备案材料自评估报告', heading: 'Title', thematicBreak: true }),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [new TableRow({ children: [cell('项目', true), cell('内容', true)] }), ...rows.map(([a, b]) => new TableRow({ children: [cell(a), cell(b)] }))],
    }),
    ...(unmet.length ? [new Paragraph({ children: [new TextRun({ text: '未达标项', bold: true, color: '8C1D18', font: '黑体' })] }), ...unmet.map((item) => new Paragraph({ children: [new TextRun({ text: `• ${item}`, color: '8C1D18', font: '宋体' })] }))] : []),
    ...(options.conclusion ? [new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [new TableRow({ children: [new TableCell({
        children: [new Paragraph({ children: [new TextRun({ text: options.conclusion, bold: true, color: '8C1D18', font: '黑体' })] })],
        borders: { top: { style: 'double', size: 8, color: '8C1D18' }, bottom: { style: 'double', size: 8, color: '8C1D18' }, left: { style: 'double', size: 8, color: '8C1D18' }, right: { style: 'double', size: 8, color: '8C1D18' } },
      })] })],
    })] : []),
    ...sections.flatMap((section, i) => [
      new Paragraph({ text: `${['一', '二', '三', '四', '五'][i] ?? '六'}、${section.title}`, heading: 'Heading1', run: { color: '8C1D18', font: '黑体' } }),
      new Paragraph({ children: [new TextRun({ text: `（一）${section.title}`, bold: true, color: '8C1D18', font: '黑体' })] }),
      new Paragraph({ children: [new TextRun({ text: section.body, font: '宋体' })] }),
      ...(section.table ? [new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({ tableHeader: true, children: section.table.headers.map((h) => cell(h, true)) }),
          ...section.table.rows.map((r) => new TableRow({ children: r.map((v) => cell(v)) })),
        ],
      })] : []),
    ]),
  ];
  const document = new Document({ sections: [{
    headers: { default: new Header({ children: [new Paragraph({ children: [new TextRun({ text: `${info.platformName} ${info.reportNo}`, font: '宋体' })] })] }) },
    footers: { default: new Footer({ children: [new Paragraph({ children: [
      new TextRun('第 '), new TextRun({ children: [PageNumber.CURRENT] }), new TextRun(' 页 共 '),
      new TextRun({ children: [PageNumber.TOTAL_PAGES] }), new TextRun(' 页'),
    ] })] }) },
    children: body,
  }] });
  return Packer.toBuffer(document);
}
