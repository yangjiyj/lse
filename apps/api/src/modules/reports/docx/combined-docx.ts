// 组合报告导出 Word：与 PDF/HTML 同一份版面内容（buildCombinedView）。
import type { FileChild } from 'docx';
import type { CombinedTable, CombinedView } from '../combined-render.js';
import {
  bullets,
  docTitle,
  gap,
  heading1,
  heading2,
  kvTable,
  numbered,
  packDocx,
  para,
  table,
} from './docx-kit.js';

const CHAPTER_NO = ['一', '二', '三', '四', '五', '六'];

export async function renderCombinedDocx(
  view: CombinedView,
  opts: { watermark?: string | null } = {},
): Promise<Buffer> {
  const out: FileChild[] = [];
  let no = 0;
  const chapter = (title: string) => {
    out.push(heading1(`${CHAPTER_NO[no] ?? String(no + 1)}、${title}`));
    no += 1;
  };
  const tbl = (t: CombinedTable) => out.push(table(t.headers, t.rows, t.weights), gap());

  out.push(para(view.platform, { bold: true, color: '987329' }));
  out.push(docTitle(view.title), para(view.subtitle, { bold: true }));
  out.push(kvTable(view.meta), gap());

  chapter('结论');
  out.push(...numbered(view.conclusion));

  chapter('任务清单');
  tbl(view.taskTable);
  out.push(para(view.taskNote));

  chapter('风险分布');
  if (view.severityTable) {
    out.push(heading2('风险等级分布'));
    tbl(view.severityTable);
  }
  if (view.domainTable) {
    out.push(heading2('风险类别分布'));
    tbl(view.domainTable);
  }
  if (view.taskSeverityTable) {
    out.push(heading2('各任务风险等级'));
    tbl(view.taskSeverityTable);
  }
  if (!view.severityTable && !view.domainTable) out.push(para('所选任务均未发现风险。'));

  chapter('主要风险');
  if (view.topRiskTable) tbl(view.topRiskTable);
  else out.push(para('所选任务均未发现风险。'));

  chapter('各任务小结');
  for (const s of view.taskSummaries) {
    out.push(heading2(s.heading));
    if (s.note) out.push(para(s.note, { bold: true, color: '8C1D18' }));
    s.lines.forEach((line) => out.push(para(line)));
  }

  if (view.recordTable) {
    chapter('其他检测项');
    tbl(view.recordTable);
    for (const s of view.recordSummaries) {
      out.push(heading2(s.heading));
      s.lines.forEach((line) => out.push(para(line)));
    }
  }

  out.push(heading1('附录　统计口径'), ...bullets(view.notes));

  return packDocx(view.title, out, {
    watermark: opts.watermark,
    headerText: view.page?.headerText ?? `${view.platform}　${view.title}`,
    footerText: view.page?.footerText ?? `报告编号 ${view.reportId}`,
  });
}
