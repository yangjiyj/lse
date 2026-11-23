// 通用报告导出 Word（2.6.2）：与 HTML/PDF 同一份报告模型，主章节为结论、概览、风险分布、主要风险、整改建议、附录。
import type { FileChild } from 'docx';
import { badRequest } from '../../../lib/errors.js';
import { DEFAULT_PLATFORM_TITLE_TEXT } from '../../../lib/product-name.js';
import type { HtmlReportModel } from '../html/model.js';
import { plainEvidenceText } from '../html/render.js';
import { findingId, formatPercent, humanizeIdentifiers, type SeverityKey } from '../html/derive.js';
import type { ViewListRow } from '../html/report-view.js';
import type { ReportSectionKey } from '../labels.js';
import {
  bullets,
  docTitle,
  gap,
  heading1,
  heading2,
  kvTable,
  labelled,
  numbered,
  packDocx,
  para,
  table,
} from './docx-kit.js';

const CHAPTER_NO = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/** 摘要句沿用 HTML 的「第 N 章」；Word 只有主章节、编号不同，改成章节名。 */
function wordSentence(text: string): string {
  return text
    .replace(/按第 \d+ 章路线图推进/g, '按「整改建议」一章推进')
    .replace(/逐条结论见第 \d+ 章/g, '逐条结论见 PDF 或 HTML 报告的「标准条款对照」一章')
    .replace(/第 \d+ 章/g, '正文相应章节');
}

function findingRows(rows: ViewListRow[]): string[][] {
  return rows.map((r) => [
    r.id,
    r.title,
    r.domainLabel,
    r.severityLabel,
    r.summary,
    String(r.count),
    r.evidenceIds.length > 4
      ? `${r.evidenceIds.slice(0, 3).join('、')} 等 ${r.evidenceIds.length} 项`
      : r.evidenceIds.join('、'),
  ]);
}

const FINDING_HEADERS = [
  '编号',
  '风险标题',
  '风险类别',
  '严重度',
  '一句话问题',
  '题数',
  '证据编号',
];
const FINDING_WEIGHTS = [11, 16, 12, 8, 33, 6, 14];

export async function renderReportDocx(
  model: HtmlReportModel,
  opts: { watermark?: string | null } = {},
): Promise<Buffer> {
  // 终端报告的版面（被测电脑、智能体清单、真机场景）不在通用模型里，导出 Word 会丢内容。
  if (model.endpointSummary) {
    throw badRequest('终端报告暂不支持 Word，请下载 PDF 或 HTML', 'REPORT_DOCX_UNSUPPORTED');
  }
  const view = model.view;
  const cv = view.cover;
  const has = (k: ReportSectionKey) => model.sectionScope.includes(k);
  const out: FileChild[] = [];
  let no = 0;
  const chapter = (title: string) => {
    out.push(heading1(`${CHAPTER_NO[no] ?? String(no + 1)}、${title}`));
    no += 1;
  };

  // 封面
  out.push(
    para(model.cover?.kicker ?? DEFAULT_PLATFORM_TITLE_TEXT, { bold: true, color: '987329' }),
  );
  out.push(docTitle(model.cover?.title ?? cv.title));
  out.push(
    para(`评估对象：${cv.objectName}${cv.objectDetail ? `（${cv.objectDetail}）` : ''}`),
    para(`总体风险等级：${cv.level.label}`, { bold: true }),
  );
  out.push(
    kvTable([
      { k: '报告编号', v: cv.reportId || '—' },
      { k: '版本号', v: cv.version },
      { k: '评估日期', v: cv.evalDate || model.reportDate || '—' },
      { k: '密级', v: cv.classification || '内部使用' },
      ...(model.cover?.organization ? [{ k: '检测单位', v: model.cover.organization }] : []),
      ...(model.cover?.client ? [{ k: '委托单位', v: model.cover.client }] : []),
    ]),
    gap(),
  );

  // 结论
  chapter('结论');
  out.push(labelled('总体风险等级', cv.level.label));
  out.push(labelled('等级依据', `${cv.level.reason}。等级规则见附录 A。`));
  if (cv.passRate.valid > 0) {
    out.push(
      labelled(
        '有效判定通过率',
        `${formatPercent(cv.passRate.passed / cv.passRate.valid, 1)}（${cv.passRate.passed} / ${cv.passRate.valid}）`,
      ),
    );
  }
  if (cv.scoreHint) out.push(para(cv.scoreHint));
  out.push(...numbered(view.exec.sentences.map(wordSentence)));
  if (view.exec.cards.length) {
    out.push(
      table(
        ['指标', '数值', '说明'],
        view.exec.cards.map((c) => [c.label, c.value, c.sub]),
        [3, 2, 5],
      ),
      gap(),
    );
  }
  if (view.exec.topThemes.length) {
    out.push(heading2(`最需要先处理的 ${view.exec.topThemes.length} 件事`));
    out.push(
      ...numbered(
        view.exec.topThemes.map(
          (t) =>
            `${t.name}（${t.priority} · 工作量${t.effortLabel}，${t.effortRange}）：可消除 ${t.count} 项风险，占全部发现的 ${formatPercent(t.share, 0)}`,
        ),
      ),
    );
  }

  // 概览
  chapter('概览');
  out.push(heading2('评估对象与范围'), kvTable(view.scope.target), gap());
  if (view.scope.modules.length) {
    out.push(
      table(
        ['评估模块', '测试项', '通过', '发现风险', '暂无法判定'],
        view.scope.modules.map((m) => [
          m.label,
          String(m.tested),
          String(m.passed),
          String(m.found),
          String(m.undetermined),
        ]),
        [4, 1.5, 1.5, 1.5, 1.5],
      ),
      gap(),
    );
  }
  if (has('resultOverview')) {
    const ov = view.overview;
    const total = Math.max(
      1,
      ov.composition.reduce((s, c) => s + c.count, 0),
    );
    out.push(heading2(`判定构成（共 ${ov.n} 个测试项）`));
    out.push(
      table(
        ['判定', '测试项', '占比'],
        ov.composition.map((c) => [c.label, `${c.count} 项`, formatPercent(c.count / total, 1)]),
        [4, 2, 2],
      ),
    );
    if (
      ov.undeterminedDetail &&
      ov.composition.some((c) => c.key === 'undetermined' && c.count > 0)
    ) {
      out.push(para(ov.undeterminedDetail));
    }
    out.push(gap());
  }
  out.push(heading2('评估方法'), ...bullets(view.scope.methods));
  const limits = [
    ...(view.scope.reachability ? [`执行覆盖：${view.scope.reachability}`] : []),
    ...view.scope.limitations,
  ];
  if (limits.length) out.push(heading2('覆盖范围与限制'), ...bullets(limits));

  // 风险分布
  if (has('resultOverview')) {
    const ov = view.overview;
    chapter('风险分布');
    if (ov.severity.length) {
      out.push(heading2(`严重度分布（共 ${ov.findingTotal} 项风险）`));
      out.push(
        table(
          ['严重度', '风险项', '占比'],
          ov.severity.map((s) => [
            s.label,
            `${s.count} 项`,
            formatPercent(ov.findingTotal > 0 ? s.count / ov.findingTotal : 0, 1),
          ]),
          [4, 2, 2],
        ),
        gap(),
      );
    }
    if (ov.heatmap.length) {
      out.push(heading2('风险类别分布（风险类别 × 严重度）'));
      out.push(
        table(
          ['风险类别', '严重', '高危', '中危', '低危', '合计'],
          ov.heatmap.map((h) => [
            h.label,
            String(h.counts.CRITICAL),
            String(h.counts.HIGH),
            String(h.counts.MEDIUM),
            String(h.counts.LOW),
            String(h.total),
          ]),
          [5, 1, 1, 1, 1, 1],
        ),
        gap(),
      );
    }
    if (ov.rateBars.length) {
      out.push(heading2(`${ov.rateTitle}（按发现率由高到低）`));
      out.push(
        table(
          ['类别', '发现风险', '已测', '发现率'],
          ov.rateBars.map((b) => [
            b.label,
            String(b.found),
            b.tested === null ? '—' : String(b.tested),
            b.tested === null ? '未取得有效结果' : formatPercent(b.rate, 1),
          ]),
          [5, 2, 2, 2],
        ),
      );
      if (ov.rateNote) out.push(para(ov.rateNote));
    }
    if (!ov.severity.length && !ov.heatmap.length) {
      out.push(para('本次评估范围内未发现风险项。'));
    }
  }

  // 主要风险
  const hasEvidenceAppendix =
    model.evidenceDetail === 'full' && has('appendix') && model.riskItemsBySeverity.length > 0;
  if (has('riskItems')) {
    const L = view.list;
    chapter('主要风险');
    if (L.allTotal > 0) {
      const sc = view.exec.heatmap.reduce(
        (a, h) => ({
          CRITICAL: a.CRITICAL + h.counts.CRITICAL,
          HIGH: a.HIGH + h.counts.HIGH,
          MEDIUM: a.MEDIUM + h.counts.MEDIUM,
          LOW: a.LOW + h.counts.LOW,
        }),
        { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
      );
      out.push(
        para(
          `本次共发现 ${L.allTotal} 项风险：严重 ${sc.CRITICAL} 项、高危 ${sc.HIGH} 项、中危 ${sc.MEDIUM} 项、低危 ${sc.LOW} 项。严重与高危风险逐项列出，中低危风险按风险类别汇总；测试输入与模型回答原文见${hasEvidenceAppendix ? '附录 C 证据明细' : '完整报告'}。`,
        ),
      );
      if (L.filtered) {
        out.push(
          para(
            `本次导出按条件筛选，仅包含 ${L.shownTotal} 项（全部 ${L.allTotal} 项见完整报告）。`,
          ),
        );
      }
      if (L.individual.length) {
        out.push(heading2('严重与高危风险（逐项）'));
        out.push(table(FINDING_HEADERS, findingRows(L.individual), FINDING_WEIGHTS), gap());
      }
      if (L.grouped.length) {
        out.push(heading2('中危及以下风险（按风险类别汇总）'));
        out.push(table(FINDING_HEADERS, findingRows(L.grouped), FINDING_WEIGHTS), gap());
      }
    } else if (model.findings.length > 0) {
      out.push(para('本报告为存量快照，未保存逐项明细，以下为快照内保留的代表性风险。'));
      out.push(
        table(
          ['编号', '风险标题', '严重度', '说明'],
          model.findings.map((f) => [
            f.id,
            humanizeIdentifiers(f.title) || '风险项',
            f.severityLabel,
            f.conclusion,
          ]),
          [2, 4, 2, 8],
        ),
      );
    } else {
      out.push(para('本次评估范围内未发现风险项。'));
    }
  }

  // 整改建议
  const themes = view.plan.themes;
  const hasRemediation =
    has('remediation') && (themes.length > 0 || (model.remediationRows?.length ?? 0) > 0);
  if (hasRemediation || has('nextSteps')) {
    chapter('整改建议');
    if (has('remediation') && themes.length > 0) {
      out.push(
        para(
          `本次发现的 ${view.overview.findingTotal} 项风险归并为 ${themes.length} 个整改主题。P0 要求 72 小时内采取止血措施，P1 要求两周内完成，P2 要求本季度内完成。`,
        ),
      );
      for (const t of themes) {
        out.push(heading2(`${t.rank}. ${t.name}（${t.priority}）`));
        out.push(
          para(
            `可消除 ${t.count} 项风险（占全部发现的 ${formatPercent(t.share, 0)}）；工作量：${t.effortLabel}（${t.effortRange}）`,
          ),
          labelled('要解决的问题', t.problem),
          labelled('为什么重要', t.why),
          labelled('怎么做', ''),
          ...numbered(t.steps.map((s) => `${s.phase}：${s.text}`)),
          labelled('建议责任角色', t.owner),
          labelled('验收标准', t.acceptance),
          labelled(
            '关联风险编号',
            t.findingIds.length > 14
              ? `${t.findingIds.slice(0, 14).join('、')} 等 ${t.findingIds.length} 项`
              : t.findingIds.join('、'),
          ),
        );
      }
    } else if (has('remediation') && model.remediationRows && model.remediationRows.length > 0) {
      out.push(
        table(
          ['优先级', '整改项', '处置动作', '验收与复测'],
          model.remediationRows.map((r) => [
            r[0] ?? '',
            humanizeIdentifiers(r[1] ?? ''),
            r[3] ?? '',
            r[4] ?? '',
          ]),
          [2, 4, 5, 5],
        ),
        gap(),
      );
    }
    if (has('nextSteps') && view.plan.retest.length) {
      out.push(heading2('复测建议'), kvTable(view.plan.retest), gap());
    }
  }

  // 附录
  if (has('appendix')) {
    const B = view.appendixB;
    out.push(heading1('附录 A　方法与口径'));
    out.push(heading2('评分口径'), para(B.scoreNote));
    out.push(heading2('总体风险等级规则'), para(B.levelNow));
    out.push(kvTable(B.levelRules.map((r) => ({ k: r.label, v: r.rule }))), gap());
    out.push(heading2('判定口径'), kvTable(B.verdictRules), gap());
    out.push(heading2('严重度定义'), kvTable(B.severityRules), gap());
    out.push(heading2('整改优先级与排序规则'), ...bullets(B.priorityRules));
    out.push(para(`整改措施库版本 ${B.playbookVersion}。`));
    if (model.appendixSampleNote) out.push(para(model.appendixSampleNote));
    out.push(heading1('附录 B　评估对象与环境'), kvTable(view.appendixC), gap());
  }
  if (hasEvidenceAppendix) {
    out.push(heading1('附录 C　证据明细'));
    out.push(
      para('以下内容用于审计追溯，保留经脱敏和格式清理后的完整测试输入与被测对象回答原文。'),
    );
    for (const group of model.riskItemsBySeverity) {
      for (const item of group.items) {
        const sev = (group.severity ?? 'UNSPECIFIED') as SeverityKey;
        out.push(
          heading2(`${findingId(sev, item.seq)}　${item.riskDomainLabel}（${item.severityLabel}）`),
          labelled('测试样本原文', plainEvidenceText(item.questionContent)),
          labelled('评估对象响应 / 工具结果原文', plainEvidenceText(item.evidence)),
        );
      }
    }
  }

  return packDocx(cv.title, out, {
    watermark: opts.watermark,
    // 报告模板给了页眉页脚就用模板的；有下载水印时 packDocx 仍按水印写。
    headerText: model.page?.headerText ?? `${DEFAULT_PLATFORM_TITLE_TEXT}　${cv.title}`,
    footerText: model.page?.footerText ?? `报告编号 ${model.reportId || '—'}`,
  });
}
