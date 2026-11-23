import { DEFAULT_PLATFORM_TITLE_TEXT } from '../../../lib/product-name.js';
import { renderEndpointReportHtml } from '../../../../../../packages/shared/src/endpoint-report-html.js';
import type { HtmlReportModel, HtmlRtArcPoint, HtmlRtScenario, SevTone } from './model.js';
import type {
  RiskItem,
  RiskItemSeverityGroup,
  ReportRiskAttribution,
  ReportRiskEntityStat,
  ReportEntityProfile,
  ReportFatalRisks,
} from '../report-builder.js';
import type { Tone } from '../pdf.js';
import type { ReportSectionKey } from '../labels.js';
import { cssString, type ReportPageOptions } from '../report-template.js';
import type { SeverityKey } from './derive.js';
import {
  containsInternalIdentifier,
  humanizeIdentifiers,
  findingId,
  moveLabelZh,
  summarizeFinding,
} from './derive.js';
import {
  LEVEL_HEX,
  SECTIONS_CSS,
  compositionHtml,
  coverageHtml,
  coverageSummaryTableHtml,
  esc,
  execSummaryHtml,
  findingTableHtml,
  heatmapHtml,
  rateBarsHtml,
  roadmapHtml,
  severityBarsHtml,
  themeCardsHtml,
  trackingTableHtml,
} from './sections.js';

function toneVar(tone?: Tone): string {
  switch (tone) {
    case 'good':
      return 'var(--pass)';
    case 'bad':
      return 'var(--sev-high)';
    case 'critical':
      return 'var(--sev-critical)';
    case 'warn':
      return 'var(--sev-medium)';
    case 'info':
      return 'var(--brand)';
    default:
      return 'var(--brand)';
  }
}

function sevVar(t: SevTone): string {
  switch (t) {
    case 'critical':
      return 'var(--sev-critical)';
    case 'high':
      return 'var(--sev-high)';
    case 'medium':
      return 'var(--sev-medium)';
    case 'low':
      return 'var(--sev-low)';
    case 'pass':
      return 'var(--pass)';
    default:
      return 'var(--sev-info)';
  }
}

function riskTone(sev: string): SevTone {
  if (sev === 'CRITICAL') return 'critical';
  if (sev === 'HIGH') return 'high';
  if (sev === 'MEDIUM') return 'medium';
  if (sev === 'LOW') return 'low';
  return 'info';
}

/** 证据原文去掉 Markdown 记号后原样保留（HTML 附录与 Word 共用）。 */
export function plainEvidenceText(value: string): string {
  return String(value ?? '')
    .replace(/^\s*```[^\n]*$/gm, '')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 附录 A：把已定位的问题片段高亮引用；位置与当前原文不一致时给出提示，不盲信旧坐标。 */
function riskEvidenceHtml(item: RiskItem): string {
  const selection = item.evidenceSelection;
  const storedSnippets = selection?.snippets ?? [];
  const snippets = storedSnippets.filter(
    (snippet) =>
      Number.isInteger(snippet.start) &&
      Number.isInteger(snippet.end) &&
      snippet.start >= 0 &&
      snippet.end > snippet.start &&
      item.evidence.slice(snippet.start, snippet.end) === snippet.text,
  );
  const stale = snippets.length !== storedSnippets.length;
  const status =
    selection?.status === 'LOCATED' && !stale
      ? '原文引用已定位；是否构成风险仍以判定规则和复核状态为准。'
      : selection?.status === 'MISSING_RESPONSE'
        ? '缺少被测对象的回答，无法用判定评语替代原文证据。'
        : '尚未确认决定性证据；如有候选片段，需结合完整回答复核。';
  const refs = snippets
    .map((snippet) => {
      const source =
        snippet.sourceKind === 'RED_TEAM_TURN'
          ? '红队逐轮响应'
          : snippet.sourceKind === 'GATEWAY_RESPONSE'
            ? '网关响应'
            : '评估结果响应';
      return `<div class="evidence-quote"><div class="note">${esc(source)} · ${esc(snippet.sourceId || '来源标识未记录')}${snippet.roundNumber ? ` · 第 ${snippet.roundNumber} 轮` : ''} · 字符区间 [${snippet.start}, ${snippet.end})</div><blockquote><mark>${esc(snippet.text)}</mark></blockquote></div>`;
    })
    .join('');
  const limitations = selection?.limitations?.length
    ? `<div class="note">${esc(selection.limitations.join('；'))}</div>`
    : '';
  if (!snippets.length && !stale) return '';
  return `<div class="micro b2">原文定位</div><p class="note">${esc(stale ? '引用位置与当前原文不一致，需重新定位并复核。' : status)}</p>${refs}${limitations}`;
}

function evidenceAppendixHtml(groups: RiskItemSeverityGroup[]): string {
  return groups
    .flatMap((group) =>
      group.items.map(
        (
          item,
        ) => `<article class="evidence-record" id="evidence-${esc(item.severity || 'INFO')}-${item.seq}">
          <div class="evidence-record-head">
            <span class="sev-pill" style="background:${sevVar(riskTone(group.severity))}">${esc(item.severityLabel)}</span>
            <b>${esc(findingId((group.severity ?? 'UNSPECIFIED') as SeverityKey, item.seq))}　${esc(item.riskDomainLabel)}</b>
          </div>
          <div class="evidence-full">
            <div class="micro">测试样本原文</div>
            <div class="body">${esc(plainEvidenceText(item.questionContent))}</div>
            <div class="micro b2">评估对象响应 / 工具结果原文</div>
            <div class="body">${esc(plainEvidenceText(item.evidence))}</div>
            ${riskEvidenceHtml(item)}
          </div>
        </article>`,
      ),
    )
    .join('');
}

const DEFAULT_HEADER_CONTENT = 'content:"大模型安全评估报告"';
const DEFAULT_FOOTER_CONTENT = `text-align:center; content:"${DEFAULT_PLATFORM_TITLE_TEXT}"`;

/**
 * 报告页面样式：填上页脚的报告编号；报告模板给了页眉、页脚时替换 @page 的 @top-left、@bottom-center。
 * 模板文字经 cssString 处理，不能结束 CSS 字符串或拼出 </style>。
 */
export function reportPageStyle(reportIdLabel: string, page: ReportPageOptions = {}): string {
  let style = STYLE.replace('REPORT_ID_PLACEHOLDER', () => reportIdLabel);
  if (page.headerText) {
    style = style.replace(DEFAULT_HEADER_CONTENT, () => `content:"${cssString(page.headerText!)}"`);
  }
  if (page.footerText) {
    style = style.replace(
      DEFAULT_FOOTER_CONTENT,
      () => `text-align:center; content:"${cssString(page.footerText!)}"`,
    );
  }
  return style;
}

/** 报告 HTML 样式（组合报告共用，保证版式和下载水印的写法一致）。 */
export const STYLE = `
:root{
  --brand-navy:#071B37; --brand:#175A96; --brand-deep:#123B68; --brand-light:#EDF4FB; --brand-tint:#D4E4F2;
  --audit-gold:#C9A04F; --accent:#C9A04F; --accent-deep:#987329; --accent-soft:#FFF8E7;
  --sev-critical:#B3261E; --sev-critical-bg:#FCEDEC;
  --sev-high:#E8590C; --sev-high-bg:#FFF0E6;
  --sev-medium:#D9A400; --sev-medium-bg:#FFF7DB;
  --sev-low:#5B7A99; --sev-low-bg:#EEF3F8;
  --sev-info:#6B7280; --sev-info-bg:#F4F5F7;
  --pass:#1E9E5A; --pass-bg:#EAF7F0;
  --ink:#18222E; --ink-soft:#3C4756; --ink-faint:#74808E;
  --hairline:#DDE5EE; --zebra:#F2F6FB; --paper:#FFFFFF;
  --cn:"Source Han Sans SC","Noto Sans CJK SC","PingFang SC","Microsoft YaHei",sans-serif;
  --mono:"Sarasa Mono SC","JetBrains Mono","SF Mono",ui-monospace,monospace;
}
@page{ size:A4; margin:17mm 16mm 16mm 16mm;
  @top-left{ width:70mm; content:"大模型安全评估报告"; font-family:var(--cn); font-size:8pt; color:#9AA7B5; }
  @top-right{ content:none; }
  @bottom-left{ width:70mm; content:"REPORT_ID_PLACEHOLDER"; font-family:var(--cn); font-size:7.5pt; color:#9AA7B5; }
  @bottom-center{ width:70mm; text-align:center; content:"${DEFAULT_PLATFORM_TITLE_TEXT}"; font-family:var(--cn); font-size:7.5pt; color:#9AA7B5; }
  @bottom-right{ width:28mm; text-align:right; content:"第 " counter(page) " / " counter(pages) " 页"; font-family:var(--cn); font-size:7.5pt; color:#9AA7B5; }
}
@page cover{ margin:0; @top-left{content:none} @top-right{content:none} @bottom-left{content:none} @bottom-center{content:none} @bottom-right{content:none} }
*{ box-sizing:border-box; }
html{ font-family:var(--cn); color:var(--ink); font-size:10.5pt; line-height:1.6; }
body{ margin:0; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
h1,h2{ margin:0; font-weight:700; } p{ margin:0 0 6px; }
.num{ font-variant-numeric:tabular-nums; }
.cover{ page:cover; height:297mm; position:relative; color:#fff; overflow:hidden;
  background:linear-gradient(155deg,var(--brand-navy) 0%,var(--brand-deep) 68%,var(--brand) 100%); }
.cover::after{ content:""; position:absolute; right:-55mm; top:-42mm; width:125mm; height:125mm; transform:rotate(24deg);
  border:18mm solid rgba(201,160,79,.16); }
.cls-banner{ position:absolute; left:0; right:0; height:9mm; display:flex; align-items:center; justify-content:center;
  background:rgba(7,27,55,.94); color:#fff; font-size:8.5pt; letter-spacing:.24em; font-weight:700; }
.cls-banner.top{ top:0; border-bottom:1px solid rgba(201,160,79,.8) } .cls-banner.bottom{ bottom:0; border-top:1px solid rgba(201,160,79,.8) }
.cover-body{ position:absolute; left:22mm; right:22mm; top:74mm; z-index:2; }
.cover-kicker{ font-size:10.5pt; letter-spacing:.3em; color:var(--accent); margin-bottom:6mm; font-weight:600; }
.cover .accent-rule{ width:34mm; height:4px; background:var(--accent); border-radius:2px; margin-bottom:8mm; }
.cover h1{ font-size:30pt; line-height:1.28; }
.cover .sub{ font-size:13pt; color:#D6E6F6; margin-top:6mm; font-weight:500; }
.verdict-chip-cover{ display:inline-flex; align-items:center; gap:8px; margin-top:9mm; padding:5px 16px; border-radius:6px; font-size:13pt; font-weight:700; color:#fff; }
.cover-meta{ position:absolute; left:22mm; right:22mm; bottom:24mm; z-index:2;
  border-top:2px solid rgba(244,180,0,.55); padding-top:7mm; display:grid; grid-template-columns:1fr 1fr; gap:5mm 12mm; }
.cover-meta .k{ font-size:8.5pt; color:#9FBEDD; letter-spacing:.05em; }
.cover-meta .v{ font-size:11pt; color:#EAF1FA; font-weight:500; margin-top:1mm; }
.sec-h{ display:flex; align-items:baseline; gap:10px; margin:18px 0 10px; padding-bottom:6px;
  border-bottom:2px solid var(--brand); break-after:avoid; position:relative; }
.sec-h::after{ content:""; position:absolute; left:0; bottom:-2px; width:46px; height:2px; background:var(--accent); }
.sec-h .no{ font-size:11pt; color:var(--brand); font-weight:800; }
.sec-h h2{ font-size:14pt; }
.sec-h .en{ margin-left:auto; font-size:8.5pt; color:var(--ink-faint); letter-spacing:.08em; text-transform:uppercase; }
.lead{ color:var(--ink-soft); }
.verdict{ display:flex; border-radius:10px; overflow:hidden; break-inside:avoid; border:1px solid var(--hairline); margin:4px 0 14px; }
.verdict .flag{ width:9px; } .verdict .body{ flex:1; padding:14px 18px; }
.verdict .row1{ display:flex; align-items:center; gap:12px; }
.verdict .word{ font-size:20pt; font-weight:800; }
.verdict .why{ margin-top:7px; color:var(--ink-soft); font-size:10.5pt; }
.verdict .basis{ margin-top:4px; font-size:9pt; color:var(--ink-faint); }
.kpi{ display:grid; grid-template-columns:repeat(5,1fr); gap:9px; margin:6px 0 4px; break-inside:avoid; }
.card{ border:1px solid var(--hairline); border-radius:9px; padding:11px 12px 12px; background:#fff; }
.card .lab{ font-size:8pt; color:var(--ink-faint); letter-spacing:.06em; }
.card .big{ font-size:25pt; font-weight:800; line-height:1.05; margin-top:3px; }
.card .frac{ font-size:9pt; color:var(--ink-faint); margin-top:1px; }
.card.accent{ border-left:4px solid var(--c,var(--brand)); }
.card.muted{ background:var(--zebra); opacity:.6; }
.score-wrap{ display:flex; gap:16px; align-items:center; border:1px solid var(--hairline); border-radius:10px; padding:14px 18px; background:#fff; break-inside:avoid; margin:4px 0; }
.density-badge{ width:66px; height:66px; border-radius:14px; display:flex; flex-direction:column; align-items:center; justify-content:center; flex:0 0 66px; color:#fff; }
.density-badge .g{ font-size:22pt; font-weight:800; line-height:.95; } .density-badge .s{ font-size:8pt; opacity:.9; }
.derive .formula{ font-size:12.5pt; } .derive .formula b{ color:var(--sev-high); } .derive .formula .res{ font-weight:800; }
.derive .note{ font-size:9pt; color:var(--ink-faint); margin-top:5px; }
.gate{ margin-top:7px; font-size:9.5pt; background:var(--accent-soft); border-left:3px solid var(--accent-deep); padding:6px 10px; border-radius:0 6px 6px 0; color:var(--ink-soft); }
.dist{ display:grid; grid-template-columns:1fr 1fr; gap:18px; break-inside:avoid; margin-top:6px; }
.dist .ttl{ font-size:9pt; color:var(--ink-faint); margin-bottom:6px; }
.stack{ display:flex; height:26px; border-radius:6px; overflow:hidden; border:1px solid var(--hairline); }
.stack .seg{ display:flex; align-items:center; justify-content:center; color:#fff; font-size:8.5pt; font-weight:600; }
.stack-legend{ display:flex; gap:14px; margin-top:7px; font-size:8.5pt; color:var(--ink-soft); }
.stack-legend i{ width:9px; height:9px; border-radius:2px; display:inline-block; margin-right:4px; vertical-align:middle; }
.waffle{ display:flex; flex-wrap:wrap; gap:6px; }
.cell{ width:38px; height:38px; border-radius:7px; display:flex; align-items:center; justify-content:center; font-size:7.5pt; font-weight:600; color:#fff; }
.mini-table{ width:100%; border-collapse:collapse; margin-top:4px; }
.mini-table td{ padding:4px 6px; font-size:9pt; border-bottom:1px solid var(--hairline); }
.mini-table .track{ position:relative; background:var(--zebra); height:9px; border-radius:5px; width:100%; }
.mini-table .fill{ position:absolute; left:0; top:0; height:9px; border-radius:5px; }
.mini-table .cnt{ text-align:right; color:var(--ink-soft); white-space:nowrap; }
.sample-note{ margin-top:10px; font-size:9pt; color:var(--ink-faint); background:var(--accent-soft); border-radius:6px; padding:6px 10px; }
.sentence{ margin:8px 0; color:var(--ink-soft); } .sentence b{ color:var(--ink); }
table.t{ width:100%; border-collapse:collapse; table-layout:fixed; font-size:9pt; margin:4px 0 6px; }
table.t thead th{ background:var(--brand-deep); color:#fff; text-align:left; padding:7px 9px; font-weight:600; font-size:8.5pt; }
table.t tbody td{ padding:7px 9px; border-bottom:1px solid var(--hairline); vertical-align:top; overflow-wrap:anywhere; word-break:break-word; }
table.t tbody tr:nth-child(even){ background:var(--zebra); } table.t tr{ break-inside:avoid; }
table.t .c{ text-align:center; }
.tag{ display:inline-block; padding:1px 7px; border-radius:4px; font-size:8pt; font-weight:600; }
.tag.ok{ background:var(--pass-bg); color:var(--pass); } .tag.skip{ background:var(--sev-info-bg); color:var(--sev-info); } .tag.warn{ background:var(--sev-medium-bg); color:var(--sev-medium); }
.fold{ font-size:8pt; color:var(--ink-faint); }
.risk-grp{ margin:10px 0 4px; }
.risk-grp-h{ display:flex; align-items:center; gap:8px; font-size:10.5pt; font-weight:700; color:var(--ink); margin:14px 0 8px; padding-bottom:4px; border-bottom:1px solid var(--hairline); break-after:avoid; }
.finding{ border:1px solid var(--hairline); border-left:6px solid var(--hairline); border-radius:8px; padding:13px 16px; margin:8px 0 12px; }
.finding .fb{ min-width:0; }
.f-head{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; break-inside:avoid; break-after:avoid; }
.sev-pill{ display:inline-flex; align-items:center; gap:5px; padding:2px 10px; border-radius:5px; font-size:9pt; font-weight:700; color:#fff; }
.f-head .ftitle{ font-size:12pt; font-weight:700; } .f-head .fid{ margin-left:auto; font-family:var(--mono); font-size:9pt; color:var(--ink-faint); }
.f-concl{ margin:9px 0 10px; font-size:10.5pt; font-weight:600; }
.kv{ font-size:9pt; margin-bottom:10px; break-inside:avoid; }
.kv .k{ display:block; color:var(--ink-faint); font-weight:600; margin-top:7px; } .kv .v{ display:block; color:var(--ink-soft); overflow-wrap:anywhere; word-break:break-word; white-space:pre-wrap; line-height:1.55; }
.evidence{ background:var(--zebra); border-radius:7px; padding:10px 12px; font-size:9pt; }
.evidence .micro{ font-size:8.5pt; font-weight:700; color:var(--sev-high); margin-bottom:4px; }
.evidence .micro.b2{ margin-top:9px; }
.evidence .body,.evidence-full .body{ font-family:var(--mono); font-size:8.6pt; color:var(--ink-soft); line-height:1.55; overflow-wrap:anywhere; word-break:break-word; white-space:pre-wrap; }
.evidence-record{ border-top:1px solid var(--hairline); padding:10px 0 14px; break-inside:auto; page-break-inside:auto; }
.evidence-record-head{ display:flex; align-items:center; gap:8px; margin-bottom:7px; }
.evidence-record-head span:last-child{ margin-left:auto; color:var(--ink-faint); }
.evidence-full{ background:#F7F9FC; border:1px solid var(--hairline); border-radius:6px; padding:10px 12px; }
.evidence-full .micro{ color:var(--brand-deep); font-size:8.5pt; font-weight:700; }
.evidence-full .micro.b2{ margin-top:10px; }
.evidence-quote{ border-left:3px solid var(--audit-gold); margin:8px 0; padding:6px 10px; background:#fffdf6; }
.evidence-quote blockquote{ margin:5px 0; white-space:pre-wrap; overflow-wrap:anywhere; font-size:9.3pt; line-height:1.6; }
.evidence-quote mark{ background:#fff0b3; color:var(--ink); }
.remediation-card{ border:1px solid var(--hairline); border-top:3px solid var(--brand); border-radius:5px; padding:12px 15px; margin:12px 0; break-inside:avoid; }
.remediation-card h3{ margin:0 0 5px; font-size:11pt; }
.remediation-priority{ color:var(--sev-high); margin-right:8px; }
.remediation-columns{ display:grid; grid-template-columns:1fr 1fr; gap:18px; font-size:9pt; line-height:1.6; }
.remediation-columns b{ color:var(--brand); }
.remediation-columns p{ white-space:pre-line; overflow-wrap:anywhere; margin-top:5px; }
.evidence-link{ color:var(--brand); font-size:8.5pt; text-decoration:underline; }
.evidence .note{ font-family:var(--cn); font-size:8pt; color:var(--ink-faint); overflow-wrap:anywhere; }
.sandbox-note{ margin-top:8px; font-size:8.5pt; line-height:1.5; background:var(--accent-soft); border-left:3px solid var(--accent-deep); border-radius:0 6px 6px 0; padding:7px 10px; color:var(--ink-soft); }
.sandbox-note b{ color:var(--accent-deep); }
.rt-sum{ display:flex; gap:10px; margin:4px 0 10px; }
.rt-stat{ flex:1; border:1px solid var(--hairline); border-radius:8px; padding:8px 10px; text-align:center; }
.rt-stat .n{ font-size:18pt; font-weight:800; } .rt-stat .l{ font-size:8pt; color:var(--ink-faint); }
.scenario{ border:1px solid var(--hairline); border-radius:9px; padding:11px 14px; margin:8px 0; break-inside:auto; page-break-inside:auto; }
.sc-head,.turn .tno{ break-after:avoid; }
.scenario.broke{ border-color:var(--sev-high); border-width:1.5px; }
.sc-head{ display:flex; align-items:center; gap:9px; flex-wrap:wrap; } .sc-head .nm{ font-weight:700; font-size:10.5pt; }
.pill{ padding:1px 8px; border-radius:4px; font-size:8pt; font-weight:600; }
.pill.side{ background:var(--brand-light); color:var(--brand); }
.pill.broke{ background:var(--sev-high-bg); color:var(--sev-high); } .pill.hold{ background:var(--pass-bg); color:var(--pass); }
.pill.turn{ background:var(--zebra); color:var(--ink-soft); } .pill.stop{ background:transparent; color:var(--ink-faint); border:1px solid var(--hairline); }
.strip{ display:flex; align-items:center; gap:0; margin:10px 0 8px; flex-wrap:wrap; }
.node{ width:24px; height:24px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:8.5pt; font-weight:700; color:#fff; }
.node.unknown{ background:var(--ink-faint); } .node.hold{ background:var(--pass); } .node.wob{ background:var(--sev-medium); } .node.broke{ background:var(--sev-high); }
.link{ height:3px; width:22px; background:var(--hairline); } .link.broke{ background:linear-gradient(90deg,var(--sev-medium),var(--sev-high)); }
.breach-mark{ font-size:8pt; color:var(--sev-high); margin-left:8px; font-weight:600; }
.sc-advice{ font-size:9pt; color:var(--ink-soft); margin-top:5px; } .sc-advice b{ color:var(--ink); }
.sc-desc{ font-size:9pt; color:var(--ink-faint); margin-top:3px; }
.breach{ margin-top:10px; background:#fff; border:1px dashed var(--sev-high); border-radius:8px; padding:12px 14px; }
.breach .bh{ font-size:9.5pt; font-weight:700; color:var(--sev-high); margin-bottom:8px; }
.breach .bh .badge{ background:var(--sev-high); color:#fff; border-radius:4px; padding:1px 7px; font-size:8pt; margin-right:8px; }
.arc-wrap{ display:flex; gap:14px; align-items:center; } .arc-cap{ font-size:8.5pt; color:var(--ink-soft); } .arc-cap b{ color:var(--sev-high); }
.moves{ margin:8px 0; font-size:8.5pt; color:var(--ink-faint); }
.move-chip{ display:inline-block; background:var(--brand-light); color:var(--brand); border-radius:4px; padding:1px 7px; margin:0 3px 3px 0; font-weight:600; }
.turn{ margin-top:8px; }
.turn .tno{ font-size:8.5pt; font-weight:700; color:var(--brand); margin-bottom:3px; }
.turn .tno small{ color:var(--ink-faint); font-weight:400; margin-left:6px; }
.turn .tbody{ border-left:2px solid var(--hairline); padding:0 0 6px 10px; } .turn.brk .tbody{ border-left-color:var(--sev-high); }
.msg{ font-size:9pt; margin:2px 0; overflow-wrap:anywhere; } .msg .who{ font-weight:600; } .msg .who.atk{ color:var(--sev-high); } .msg .who.mdl{ color:var(--brand); }
.att{ display:inline-block; font-size:7.5pt; font-weight:700; padding:0 6px; border-radius:3px; margin-left:6px; }
.att.pass{ background:var(--pass-bg); color:var(--pass); } .att.medium{ background:var(--sev-medium-bg); color:var(--sev-medium); } .att.high{ background:var(--sev-high-bg); color:var(--sev-high); }
.brkpt{ margin-top:6px; font-size:8.5pt; background:var(--sev-high-bg); border-radius:6px; padding:6px 9px; color:var(--ink-soft); } .brkpt b{ color:var(--sev-high); }
.illus{ font-size:7.5pt; color:var(--ink-faint); margin-top:6px; font-style:italic; }
.rule-card{ background:var(--accent-soft); border-left:4px solid var(--accent-deep); border-radius:0 8px 8px 0; padding:11px 14px; margin:8px 0; break-inside:avoid; }
.rule-card .rt{ font-weight:700; color:var(--accent-deep); font-size:10pt; margin-bottom:5px; }
.rule-card .rl{ font-size:9pt; color:var(--ink-soft); margin:3px 0; } .rule-card .rl b{ color:var(--ink); }
.toc-block{ margin-top:6px; }
.toc-list{ list-style:none; padding:0; margin:6px 0; } .toc-list li{ margin:8px 0; }
.toc-list a{ display:flex; align-items:baseline; text-decoration:none; color:var(--ink-soft); font-size:10.5pt; }
.toc-list a .tx{ flex:0 0 auto; } .toc-list a .dots{ flex:1; border-bottom:1px dotted #B8C6D6; margin:0 6px; transform:translateY(-3px); }
.toc-list a::after{ content: target-counter(attr(href), page); flex:0 0 auto; color:var(--ink-faint); }
.callout-green{ background:var(--pass-bg); border-left:4px solid var(--pass); border-radius:0 8px 8px 0; padding:10px 14px; color:#14532D; font-size:10pt; }
.pb{ break-before:page; } .newpage{ break-before:page; } .appendix{ break-inside:auto; }
.cover-badges{ margin-top:9mm; } .lvl-chip{ display:inline-block; padding:6px 18px; border-radius:6px; font-size:14pt; font-weight:800; color:#fff; margin-right:10px; } .score-chip{ display:inline-block; padding:6px 16px; border-radius:6px; font-size:13pt; font-weight:700; color:#fff; border:1.5px solid rgba(255,255,255,.7); }
.front{ break-before:page; }
${SECTIONS_CSS}
`;
function arcSvg(arc: HtmlRtArcPoint[]): string {
  const W = 300;
  const H = 132;
  const xs = arc.length === 1 ? [180] : arc.map((_, i) => 120 + (i * (W - 130)) / (arc.length - 1));
  const yByLevel = { 3: 14, 2: 46, 1: 78, 0: 110 } as const;
  const pts = arc.map((p, i) => `${xs[i]},${yByLevel[p.level]}`).join(' ');
  const grid = [
    [14, '裁判通过', '#1E9E5A'],
    [110, '裁判风险', '#B3261E'],
  ]
    .map(
      ([y, label, color]) =>
        `<line x1="64" y1="${y}" x2="290" y2="${y}" stroke="${y === 110 ? '#FCE3E1' : '#EDF1F6'}"/><text x="60" y="${Number(y) + 3}" text-anchor="end" fill="${color}">${label}</text>`,
    )
    .join('');
  const dots = arc
    .map(
      (p, i) =>
        `<circle cx="${xs[i]}" cy="${yByLevel[p.level]}" r="${p.breach ? 6.5 : 5}" fill="${p.breach ? '#B3261E' : '#E07B00'}"/>`,
    )
    .join('');
  const xlabels = arc
    .map(
      (p, i) =>
        `<text x="${xs[i]}" y="128" text-anchor="middle" fill="#3C4756">${esc(p.round)}</text>`,
    )
    .join('');
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <g font-family="sans-serif" font-size="8">${grid}</g>
    <polyline points="${pts}" fill="none" stroke="#D93C2E" stroke-width="2.5"/>
    ${dots}
    <g font-family="sans-serif" font-size="8">${xlabels}</g>
  </svg>`;
}

function sectionHeader(no: string, title: string, _en?: string): string {
  return `<div class="sec-h">${no ? `<span class="no">${esc(no)}</span>` : ''}<h2>${esc(title)}</h2></div>`;
}

function tableHtml(headers: string[], rows: string[][]): string {
  const thead = `<thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody>`;
  return `<table class="t">${thead}${tbody}</table>`;
}

function scenarioHtml(s: HtmlRtScenario): string {
  const strip = s.steps
    .map(
      (st, i) =>
        `${i > 0 ? `<span class="link ${s.broke && st.state === 'broke' ? 'broke' : ''}"></span>` : ''}<span class="node ${st.state}">${st.n}</span>`,
    )
    .join('');
  const breachMark = s.broke ? '<span class="breach-mark">场景最终判定：发生边界突破</span>' : '';
  let breachBlock = '';
  const evidenceTurns = s.turns ?? s.breach?.turns ?? [];
  if (evidenceTurns.length > 0) {
    const turns = evidenceTurns
      .map(
        (t) => `<div class="turn ${t.broke ? 'brk' : ''}">
        <div class="tno">${esc(t.round)}<small>${esc(t.phase)}</small></div>
        <div class="tbody">
          <div class="msg"><span class="who atk">攻击方：</span>${esc(t.attacker)}</div>
          <div class="msg"><span class="who mdl">模型：</span>${esc(t.model)}<span class="att ${t.attitudeTone}">${esc(t.judgmentLabel || '该轮内容判定未记录')}</span></div>
          <div class="note">${esc(t.wordingNote || `历史措辞标签：${t.attitudeLabel}（非安全判定）`)} · ${esc(t.sourceLabel || '')}</div>
          ${t.broke ? '<div class="brkpt"><b>逐轮记录：</b>本轮裁判标记风险；需结合该轮原始响应和判定依据复核。</div>' : ''}
        </div>
      </div>`,
      )
      .join('');
    const moves = s.movesUsed.length
      ? `<div class="moves">对抗策略序列：${s.movesUsed.map((m, mi) => `<span class="move-chip">${esc(moveLabelZh(m, mi))}</span>`).join('')}</div>`
      : '';
    breachBlock = `<div class="breach">
      <div class="bh"><span class="badge">${s.broke ? '边界变化记录' : '逐轮交互记录'}</span>场景记录 ${s.rounds} 轮，本节展示 ${evidenceTurns.length} 轮</div>
      ${s.breach?.arc.length ? `<div class="arc-wrap">${arcSvg(s.breach.arc)}<div class="arc-cap">曲线仅展示已保存的逐轮裁判结果；拒答措辞另列，不用场景最终判定回填单轮结论。</div></div>` : s.breach ? '<p class="sc-desc">部分轮次未保存独立内容判定，未绘制安全判定曲线；以下保留原始交互，历史措辞标签仅供参考。</p>' : ''}
      ${moves}
      ${turns}
      ${s.breach?.illustrative ? `<div class="illus">注：逐轮文本为脱敏示例还原；接入真实任务后此处展示该任务 transcript 的真实对话。</div>` : ''}
    </div>`;
  }
  return `<div class="scenario ${s.broke ? 'broke' : ''}">
    <div class="sc-head">
      <span class="nm">${esc(s.title)}</span>
      <span class="pill side">${esc(s.sideLabel)}</span>
      <span class="pill ${s.broke ? 'broke' : s.verdictLabel === '通过' ? 'hold' : 'turn'}">${esc(s.verdictLabel)}</span>
      <span class="pill turn">共 ${s.rounds} 轮</span>
      <span class="pill stop">停止：${esc(s.stopReason)}</span>
    </div>
    <div class="strip">${strip}${breachMark}</div>
    ${breachBlock}
    <div class="sc-advice"><b>建议：</b>${esc(s.remediation)}</div>
  </div>`;
}

let tocSeq = 0;
function tocEntry(label: string): { anchor: string; li: string } {
  tocSeq += 1;
  const anchor = `sec-${tocSeq}`;
  return {
    anchor,
    li: `<li><a href="#${anchor}"><span class="tx">${esc(label)}</span><span class="dots"></span></a></li>`,
  };
}

/** 严重风险研判章节。 */
function fatalRisksSectionHtml(f: ReportFatalRisks): string {
  const headTone: SevTone = f.fatalCount > 0 ? 'critical' : f.criticalCount > 0 ? 'high' : 'low';
  const head = `<div class="finding" style="border-left-color:${sevVar(headTone)}"><div class="fb"><div class="f-concl" style="font-weight:700">${esc(f.headline)}</div></div></div>`;
  const triage = `<div class="rt-sum">
      <div class="rt-stat" style="border-color:${sevVar('critical')}"><div class="n" style="color:${sevVar('critical')}">${f.fatalCount}</div><div class="l">严重风险行为</div></div>
      <div class="rt-stat"><div class="n" style="color:${sevVar('high')}">${f.criticalCount}</div><div class="l">高优先级风险行为</div></div>
      <div class="rt-stat"><div class="n">${f.suspectedCount}</div><div class="l">待人工确认</div></div>
      <div class="rt-stat"><div class="n" style="color:var(--pass)">${f.containedCount}</div><div class="l">已阻断或拒绝</div></div>
    </div>`;
  const incTable = f.incidents.length
    ? `<p class="lead"><b>评估中已观察到的严重风险行为</b></p>${tableHtml(
        ['风险等级', '风险类型', '时间', '工具', '目标', '请求编号', '标准依据'],
        f.incidents.map((i) => [
          i.tier,
          i.categoryLabel,
          i.occurredAt,
          i.tool || '—',
          i.target || '—',
          i.requestId.slice(0, 16),
          i.standards.slice(0, 2).join('；') || '—',
        ]),
      )}`
    : `<p class="sentence">本次评估范围内未观察到严重或高优先级风险行为；已阻断和待确认项见后续明细。</p>`;
  const baselineTable = `<p class="lead" style="margin-top:10px"><b>基线评估口径（分级依据）</b></p><p class="basis" style="font-size:9pt">${esc(f.baselineNote)}</p>${tableHtml(
    ['风险等级', '风险类型', '标准依据'],
    f.baseline.map((r) => [r.tier, r.categoryLabel, r.standards.join('；')]),
  )}`;
  return head + triage + incTable + baselineTable;
}

/** 单实体安全画像章节：某个 key/IP 的多维度深度分析（危害分/杀伤链/既遂清单/敏感目标/处置建议）。 */
function entityProfileSectionHtml(p: ReportEntityProfile): string {
  const levelTone: SevTone =
    p.harmLevel === '极高危'
      ? 'critical'
      : p.harmLevel === '高危'
        ? 'high'
        : p.harmLevel === '中危'
          ? 'medium'
          : 'low';
  const dispTone: SevTone =
    p.dispositionLevel === '立即处置'
      ? 'critical'
      : p.dispositionLevel === '优先调查'
        ? 'high'
        : p.dispositionLevel === '持续监控'
          ? 'medium'
          : 'low';
  const idCard = `<p class="lead"><b>${p.entityKind === 'key' ? '调用方标识' : '来源 IP'}：</b>${esc(p.entityId)}${p.agentType ? `　·　<b>智能体类型：</b>${esc(p.agentType)}` : ''}　·　<b>活跃：</b>${esc(p.firstSeen || '—')} ~ ${esc(p.lastSeen || '—')}</p>`;
  const scoreCard = `<div class="rt-sum">
      <div class="rt-stat" style="border-color:${sevVar(levelTone)}"><div class="n" style="color:${sevVar(levelTone)}">${p.harmScore}</div><div class="l">风险优先级分 / 100（${esc(p.harmLevel)}）</div></div>
      <div class="rt-stat"><div class="n" style="color:${sevVar('critical')}">${p.consummatedCount}</div><div class="l">评估中已观察到（高置信 ${p.ironProofCount}）</div></div>
      <div class="rt-stat"><div class="n">${p.suspectedCount}</div><div class="l">待确认</div></div>
      <div class="rt-stat"><div class="n" style="color:${sevVar('low')}">${p.attemptedCount}</div><div class="l">已阻断或拒绝</div></div>
      <div class="rt-stat"><div class="n">${p.domainCount}</div><div class="l">覆盖风险域</div></div>
      <div class="rt-stat"><div class="n">${(p.penetrationRate * 100).toFixed(0)}%</div><div class="l">已观察到风险占比</div></div>
    </div>`;
  const killChain = `<p class="lead"><b>风险链路：</b><span style="color:${p.killChainClosed ? sevVar('critical') : 'var(--ink-faint)'}">${p.killChainClosed ? '评估中已观察到完整链路' : '未观察到完整链路'}</span> — ${esc(p.killChainNote)}</p>`;
  const disp = `<div class="finding" style="border-left-color:${sevVar(dispTone)}"><div class="fb"><div class="f-head"><span class="sev-pill" style="background:${sevVar(dispTone)}">处置建议</span><span class="ftitle">${esc(p.dispositionLevel)}：${esc(p.disposition)}</span></div><div class="f-concl">${esc(p.dispositionReason)}</div></div></div>`;
  const domTable = p.domainCoverage.length
    ? `<p class="lead"><b>攻击面覆盖</b></p>${tableHtml(
        ['风险域', '命中数', '最高等级', '是否在评估中观察到'],
        p.domainCoverage.map((d) => [
          d.label,
          String(d.count),
          d.maxSeverityLabel,
          d.hasConsummated ? '是' : '否',
        ]),
      )}`
    : '';
  const ttp = [
    p.gbtClauses.length ? `GB/T 45654：${p.gbtClauses.join('、')}` : '',
    p.owaspClauses.length ? `OWASP：${p.owaspClauses.join('、')}` : '',
    p.atlasTactics.length ? `ATLAS：${p.atlasTactics.join('、')}` : '',
    p.agenticThreats.length ? `Agentic：${p.agenticThreats.join('、')}` : '',
  ]
    .filter(Boolean)
    .join('　；　');
  const ttpP = ttp ? `<p class="basis" style="font-size:9pt">合规 / TTP 覆盖：${esc(ttp)}</p>` : '';
  const tgtTable = p.sensitiveTargets.length
    ? `<p class="lead"><b>敏感目标与外带去向</b></p>${tableHtml(
        ['类型', '目标', '工具', '判定', 'requestId'],
        p.sensitiveTargets.map((t) => [
          t.group,
          t.target,
          t.tool || '—',
          t.verdictLabel,
          t.requestId.slice(0, 16),
        ]),
      )}`
    : '';
  const incTable = p.incidents.length
    ? `<p class="lead"><b>已观察到 / 待确认风险证据</b></p>${tableHtml(
        ['时间', '风险域', '判定', '工具', '目标', '请求编号'],
        p.incidents
          .slice(0, 20)
          .map((i) => [
            i.occurredAt,
            i.riskCategoryLabel,
            i.verdictLabel,
            i.tool || '—',
            i.target || '—',
            i.requestId.slice(0, 16),
          ]),
      )}`
    : '';
  return idCard + scoreCard + killChain + disp + domTable + ttpP + tgtTable + incTable;
}

/** 风险分布归因章节：按 key/源IP/agent_type 排行 + Top 风险类别（不筛选时一眼看出风险集中在谁身上）。 */
function riskAttributionSectionHtml(a: ReportRiskAttribution): string {
  const entTable = (title: string, label: string, rows: ReportRiskEntityStat[]): string => {
    if (!rows.length) return '';
    const trs = rows.map((s) => [
      s.id,
      String(s.riskCount),
      String(s.consummatedCount),
      s.maxSeverityLabel,
      s.topCategories.join('、') || '—',
    ]);
    return `<p class="lead" style="margin-top:8px"><b>${esc(title)}</b></p>${tableHtml(
      [label, '风险项', '评估中已观察到', '最高等级', '主要风险类别'],
      trs,
    )}`;
  };
  const catRows = a.categoryRanking
    .slice(0, 8)
    .map((c) => [c.label, String(c.count), c.maxSeverityLabel]);
  const head = `<div class="rt-sum">
      <div class="rt-stat"><div class="n">${a.keyCount}</div><div class="l">触发风险的 Key</div></div>
      <div class="rt-stat"><div class="n">${a.ipCount}</div><div class="l">触发风险的源 IP</div></div>
      <div class="rt-stat"><div class="n">${a.agentTypeCount}</div><div class="l">智能体类型</div></div>
      <div class="rt-stat"><div class="n">${a.totalRiskItems}</div><div class="l">风险项总数</div></div>
    </div>`;
  return (
    head +
    (catRows.length
      ? `<p class="lead"><b>主要风险类别</b></p>${tableHtml(['风险类别', '数量', '最高等级'], catRows)}`
      : '') +
    entTable('高危 Key 排行', 'Key / 调用方', a.topByKey) +
    entTable('高危源 IP 排行', '源 IP', a.topByIp) +
    entTable('智能体类型分布', '智能体类型', a.topByAgentType)
  );
}

const LEGACY_FINDING_SEV: Record<string, SeverityKey> = {
  严重: 'CRITICAL',
  高危: 'HIGH',
  中危: 'MEDIUM',
  低危: 'LOW',
};

const LEVEL_NOTE_BY_STATE = {
  good: 'var(--pass)',
  warn: 'var(--sev-medium)',
  bad: 'var(--sev-high)',
} as const;
void LEVEL_NOTE_BY_STATE;

function kvTable(rows: Array<{ k: string; v: string }>): string {
  return `<table class="t kvt"><tbody>${rows
    .map((r) => `<tr><td>${esc(r.k)}</td><td>${esc(r.v)}</td></tr>`)
    .join('')}</tbody></table>`;
}

function clauseTablesHtml(model: HtmlReportModel, startNo: number): { html: string; next: number } {
  let n = startNo;
  const parts: string[] = [];
  const tone = (v: string) =>
    v === 'nonconform' ? 'color:var(--sev-critical);font-weight:700' : v === 'conform' ? 'color:var(--ok, #1a7f37)' : 'color:var(--ink-soft)';
  for (const t of model.clauseTables) {
    parts.push(`<h3 class="sub-h${n === 0 ? ' first' : ''}">6.${++n} ${esc(t.lineLabel)}：标准条款对照</h3><p class="lead">${esc(t.statement)}</p><p class="small-note">本线共 ${t.counts.total} 项条款，本次有测试数据的 ${t.counts.tested} 项，其中不符合或发现风险 ${t.counts.nonconform} 项。未测与不适用的条款不能读作符合。</p>`);
    if (t.annexMajors) {
      parts.push(`<table class="t"><thead><tr><th style="width:44%">GB/T 45654-2025 附录 A 大类</th><th style="width:14%">有效判定</th><th style="width:14%">发现风险</th><th style="width:14%">无法判定</th><th style="width:14%">结论</th></tr></thead><tbody>${t.annexMajors
        .map((m) => `<tr><td>${esc(m.code)} ${esc(m.name)}</td><td>${m.tested}</td><td>${m.failed}</td><td>${m.invalid}</td><td style="${tone(m.label === '发现风险' ? 'nonconform' : m.label === '未测' ? 'not_tested' : 'conform')}">${esc(m.label)}</td></tr>`)
        .join('')}</tbody></table><p class="small-note">大类汇总含只能归到大类、无法归到具体小项的测试项；逐项结论见下表。</p>`);
    }
    for (const g of t.groups) {
      if (g.rows.length === 0 && g.untested.length === 0) continue;
      parts.push(`<h4 class="sub-h">${esc(g.name)}</h4>`);
      if (g.rows.length > 0) {
        parts.push(`<table class="t"><thead><tr><th style="width:30%">条款</th><th style="width:30%">内容</th><th style="width:10%">有效判定</th><th style="width:10%">不合格</th><th style="width:20%">结论</th></tr></thead><tbody>${g.rows
          .map((r) => `<tr><td class="small">${esc(r.citation)}</td><td>${esc(r.title)}</td><td>${r.tested}</td><td>${r.failed}</td><td style="${tone(r.verdict)}">${esc(r.label)}<div class="small">${esc(r.note)}</div>${r.evidence?.length ? `<div class="small" style="color:var(--ink-soft)">代表性样本：${r.evidence.map((e) => `${esc(e.sampleName)}（${esc(e.outcomeLabel)}）${esc(e.summary)}`).join('；')}</div>` : ''}</td></tr>`)
          .join('')}</tbody></table>`);
      }
      for (const line of g.untested) parts.push(`<p class="small-note">${esc(line)}</p>`);
    }
  }
  return { html: parts.join(''), next: n };
}

function complianceChapterHtml(model: HtmlReportModel): string {
  const parts: string[] = [];
  const clause = clauseTablesHtml(model, 0);
  let n6 = clause.next;
  if (clause.html) parts.push(clause.html);
  const cov = model.view.overview.coverage;
  if (cov) {
    parts.push(
      `<h3 class="sub-h${n6 === 0 ? ' first' : ''}">6.${++n6} 国际框架覆盖汇总（参考，逐条明细见 3.5 框架覆盖矩阵）</h3>${coverageSummaryTableHtml(cov)}<p class="small-note">国际框架只作对照参考，不作为合规依据。「未测试」只表示本次评估没有覆盖该条目；「平台暂不覆盖」表示平台目前没有能测这一条的评估能力。</p>`,
    );
  }
  const fw = model.internationalFrameworkRows;
  if (fw.length > 0) {
    const grouped = new Map<
      string,
      { fw: string; id: string; en: string; zh: string; domains: Set<string> }
    >();
    for (const r of fw.filter((x) => !/^GB\/T/.test(x.framework))) {
      const key = `${r.framework}|${r.entryId}`;
      const g = grouped.get(key) ?? {
        fw: r.framework,
        id: r.entryId,
        en: r.entryNameEn,
        zh: r.entryNameZh,
        domains: new Set<string>(),
      };
      g.domains.add(r.riskDomainLabel.replace(/风险$/, ''));
      grouped.set(key, g);
    }
    parts.push(`<h3 class="sub-h${n6 === 0 ? ' first' : ''}">6.${++n6} 国际框架汇总对照（按本次涉及的风险类别归并）</h3>
      <table class="t"><thead><tr><th style="width:20%">框架</th><th style="width:15%">编号</th><th style="width:33%">条目名称（中文 / 英文）</th><th>涉及风险类别</th></tr></thead><tbody>${[
        ...grouped.values(),
      ]
        .map((g) => {
          const name = g.zh && g.en ? `${g.zh} / ${g.en}` : g.zh || g.en || '—';
          return `<tr><td class="small">${esc(g.fw)}</td><td class="small" style="white-space:nowrap">${esc(g.id)}</td><td class="small">${esc(name)}</td><td class="small">${esc([...g.domains].join('、'))}</td></tr>`;
        })
        .join(
          '',
        )}</tbody></table><p class="small-note">平台参考映射，需结合证据核验，不构成认证结论。</p>`);
  }
  return parts.join('');
}

export function renderReportHtmlString(model: HtmlReportModel): string {
  if (model.endpointSummary) {
    // 终端报告走专用的客户版版式（共享渲染器，前端在线预览也用同一份）。
    return renderEndpointReportHtml(model.endpointSummary, {
      title: model.endpointSummary.mode === 'posture' ? '智能体配置体检报告' : '智能体运行态安全测评报告',
      reportId: model.reportId,
      classification: model.classification,
      generatedAt: model.generatedAtIso ?? new Date().toISOString(),
      ...(model.endpointSummary.assessedAt ? { assessedAt: model.endpointSummary.assessedAt } : {}),
      platformName: DEFAULT_PLATFORM_TITLE_TEXT,
    });
  }

  tocSeq = 0;
  const view = model.view;
  const toc: string[] = [];
  const body: string[] = [];
  const scope = model.sectionScope;
  const has = (k: ReportSectionKey) => scope.includes(k);
  let no = 0;
  const chap = (title: string, inner: string, cls = '') => {
    no += 1;
    const { anchor, li } = tocEntry(`${no}　${title}`);
    toc.push(li);
    // 章标题与首个小节同页：首个小节不长时一并包进不分页容器，避免标题孤悬在页底。
    const head = sectionHeader(String(no), title);
    const starts = [...inner.matchAll(/(?:<div class="keep">)?<h3/g)].map((m) => m.index ?? 0);
    const second = starts[1] ?? -1;
    const lead = second > 0 ? inner.slice(0, second) : inner;
    const rest = second > 0 ? inner.slice(second) : '';
    const content =
      lead.length < 7000 ? `<div class="keep">${head}${lead}</div>${rest}` : `${head}${inner}`;
    body.push(`<section id="${anchor}" class="chap ${cls}">${content}</section>`);
  };
  const hasEvidenceAppendix =
    model.evidenceDetail === 'full' && has('appendix') && model.riskItemsBySeverity.length > 0;

  // 1 管理层摘要（严格一页）
  chap('管理层摘要', execSummaryHtml(view), 'one-page exec');

  // 2 评估范围与方法
  chap(
    '评估范围与方法',
    `<h3 class="sub-h first">评估对象与范围</h3>${kvTable(view.scope.target)}
    <table class="t"><thead><tr><th>评估模块</th><th class="c" style="width:14%">测试项</th><th class="c" style="width:14%">通过</th><th class="c" style="width:14%">发现风险</th><th class="c" style="width:16%">暂无法判定</th></tr></thead><tbody>${view.scope.modules
      .map(
        (m) =>
          `<tr><td>${esc(m.label)}</td><td class="c num">${m.tested}</td><td class="c num">${m.passed}</td><td class="c num">${m.found}</td><td class="c num">${m.undetermined}</td></tr>`,
      )
      .join('')}</tbody></table>
    <h3 class="sub-h">评估方法</h3><ul class="plain">${view.scope.methods.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>
    <h3 class="sub-h">覆盖范围与限制</h3><ul class="plain">${view.scope.reachability ? `<li><b>执行覆盖：</b>${esc(view.scope.reachability)}</li>` : ''}${view.scope.limitations.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>`,
  );

  // 3 结果总览
  if (has('resultOverview')) {
    const ov = view.overview;
    let inner = `<h3 class="sub-h first">3.1 判定构成（共 ${ov.n} 个测试项）</h3>${compositionHtml(view)}`;
    if (ov.severity.length) {
      inner += `<h3 class="sub-h">3.2 严重度分布（共 ${ov.findingTotal} 项风险）</h3>${severityBarsHtml(ov.severity, ov.findingTotal)}`;
    }
    if (ov.heatmap.length) {
      inner += `<h3 class="sub-h">3.3 风险热力图（风险类别 × 严重度，单元格为风险项数，空白表示 0）</h3>${heatmapHtml(ov.heatmap)}`;
    }
    if (ov.rateBars.length) {
      inner += `<div class="keep"><h3 class="sub-h">3.4 ${esc(ov.rateTitle)}（按发现率由高到低）</h3>${rateBarsHtml(ov.rateBars, ov.rateBasis)}<p class="small-note">${esc(ov.rateNote)}</p></div>`;
    }
    if (ov.coverage) {
      inner += `<h3 class="sub-h">3.5 国际框架覆盖矩阵</h3><p class="small-note">${esc(ov.coverageSummary)}</p>${coverageHtml(ov.coverage)}`;
    }
    chap('结果总览', inner, ov.heatmap.length > 0 ? 'newpage' : '');
  }

  // 网关流量日志专有章节（沿用原版呈现）。
  if (model.fatalRisks) chap('严重风险研判', fatalRisksSectionHtml(model.fatalRisks));
  if (model.entityProfile && model.entityProfile.totalRiskItems > 0) {
    chap('单实体安全画像', entityProfileSectionHtml(model.entityProfile));
  }
  if (model.riskAttribution && model.riskAttribution.totalRiskItems > 0) {
    chap('风险分布归因', riskAttributionSectionHtml(model.riskAttribution));
  }

  // 4 整改计划
  const planParts: string[] = [];
  const themes = view.plan.themes;
  if (has('remediation') && themes.length > 0) {
    planParts.push(
      `<h3 class="sub-h first">4.1 整改路线图</h3><p class="lead">本次发现的 ${view.overview.findingTotal} 项风险归并为 ${themes.length} 个整改主题。P0 要求 72 小时内采取止血措施，P1 要求两周内完成，P2 要求本季度内完成；优先级规则见附录 A。</p>${roadmapHtml(view.plan.roadmap)}${view.plan.effortNote ? `<p class="small-note">${esc(view.plan.effortNote)}</p>` : ''}`,
    );
    planParts.push(
      themeCardsHtml(
        themes,
        '<h3 class="sub-h">4.2 整改主题卡（按「可消除风险项数 ÷ 工作量」由高到低排序）</h3>',
      ),
    );
    planParts.push(
      `<div class="keep"><h3 class="sub-h">4.3 整改跟踪表（由责任方填写）</h3>${trackingTableHtml(themes)}</div>`,
    );
  } else if (has('remediation') && model.remediationRows && model.remediationRows.length > 0) {
    // 存量快照无逐项明细时，回退为快照内已有的整改条目。
    planParts.push(
      `<h3 class="sub-h first">整改建议</h3>${tableHtml(
        ['优先级', '整改项', '处置动作', '验收与复测'],
        model.remediationRows.map((r) => [
          r[0] ?? '',
          humanizeIdentifiers(r[1] ?? ''),
          r[3] ?? '',
          r[4] ?? '',
        ]),
      )}`,
    );
  }
  if (has('nextSteps')) {
    planParts.push(
      `<div class="keep"><h3 class="sub-h${planParts.length ? '' : ' first'}">4.4 复测建议</h3>${kvTable(view.plan.retest)}</div>`,
    );
  }
  if (planParts.length) chap('整改计划', planParts.join(''), themes.length > 0 ? 'newpage' : '');

  // 5 风险发现清单
  if (has('riskItems')) {
    const L = view.list;
    let inner = '';
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
      inner += `<p class="lead">本次共发现 ${L.allTotal} 项风险：严重 ${sc.CRITICAL} 项、高危 ${sc.HIGH} 项、中危 ${sc.MEDIUM} 项、低危 ${sc.LOW} 项。严重与高危风险逐项列出，中低危风险按风险类别汇总；测试输入与模型回答原文见${hasEvidenceAppendix ? '附录 C 证据明细，点击证据编号可跳转' : '本次导出未包含（可在完整报告中查看）'}。标注「评估沙箱已阻断」的项，仅说明评估环境已拦截该操作，不代表客户生产环境已设防。</p>`;
      if (L.filtered) {
        inner += `<div class="note-box">本次导出按条件筛选，仅包含 ${L.shownTotal} 项（全部 ${L.allTotal} 项见完整报告）。</div>`;
      }
      if (L.individual.length) {
        inner += `<h3 class="sub-h">5.1 严重与高危风险（逐项）</h3>${findingTableHtml(L.individual, hasEvidenceAppendix)}`;
      }
      if (L.grouped.length) {
        inner += `<h3 class="sub-h">${L.individual.length ? '5.2' : '5.1'} 中危及以下风险（按风险类别汇总）</h3>${findingTableHtml(L.grouped, hasEvidenceAppendix)}`;
      }
    } else if (model.findings.length > 0) {
      inner += `<p class="lead">本报告为存量快照，未保存逐项明细，以下为快照内保留的代表性风险。</p><table class="t flist"><thead><tr><th style="width:9%">编号</th><th style="width:20%">风险标题</th><th style="width:10%">严重度</th><th>一句话问题</th></tr></thead><tbody>${model.findings
        .map((f) => {
          const sev = LEGACY_FINDING_SEV[f.severityLabel] ?? 'LOW';
          return `<tr><td class="num">${esc(f.id)}</td><td>${esc(humanizeIdentifiers(f.title) || '风险项')}</td><td>${esc(f.severityLabel)}</td><td>${esc(summarizeFinding({ riskExplanation: f.conclusion }, sev === 'CRITICAL' ? 'general_safety' : 'general_safety'))}</td></tr>`;
        })
        .join('')}</tbody></table>`;
    } else {
      inner += '<p class="lead">本次评估范围内未发现风险项。</p>';
    }
    chap('风险发现清单', inner, L.allTotal > 0 ? 'newpage' : '');
  }

  // 6 标准条款对照与框架参考
  if (
    has('gbtCompliance') &&
    (model.clauseTables.length > 0 || model.internationalFrameworkRows.length > 0 || view.overview.coverage)
  ) {
    chap('标准条款对照与框架参考', complianceChapterHtml(model), model.clauseTables.length > 0 ? 'newpage' : '');
  }

  // 推荐防护策略（沿用）
  if (model.protectionStrategy) {
    const ps = model.protectionStrategy;
    chap(
      '推荐防护策略',
      ps.empty
        ? '<p class="note">暂无数据</p>'
        : `${tableHtml(ps.headers, ps.rows)}<p class="note">${esc(ps.note)}</p>`,
    );
  }

  // 附录
  const appendixBody: string[] = [];
  const appx = (label: string, title: string, inner: string, cls = 'appendix newpage') => {
    const { anchor, li } = tocEntry(`${label}　${title}`);
    toc.push(li);
    appendixBody.push(
      `<section class="${cls} chap" id="${anchor}">${sectionHeader('', `${label}　${title}`)}${inner}</section>`,
    );
  };
  if (has('appendix')) {
    const B = view.appendixB;
    appx(
      '附录 A',
      '方法与口径',
      `<h3 class="sub-h first">评分口径</h3><p>${esc(B.scoreNote)}</p>
      <h3 class="sub-h">总体风险等级规则</h3><p>${esc(B.levelNow)}</p>
      <table class="t kvt"><tbody>${B.levelRules.map((r) => `<tr><td>${esc(r.label)}</td><td>${esc(r.rule)}</td></tr>`).join('')}</tbody></table>
      <h3 class="sub-h">判定口径</h3>${kvTable(B.verdictRules)}
      <h3 class="sub-h">严重度定义</h3>${kvTable(B.severityRules)}
      <h3 class="sub-h">整改优先级与排序规则</h3><ul class="plain">${B.priorityRules.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      <p class="small-note">整改措施库版本 ${esc(B.playbookVersion)}。</p>
      <p class="small-note">${esc(model.appendixSampleNote)}</p>`,
    );
    appx(
      '附录 B',
      '评估对象与环境',
      `<p class="lead">以下信息用于复现本次评估。</p>${kvTable(view.appendixC)}`,
      'appendix keep',
    );
  }
  if (hasEvidenceAppendix) {
    appx(
      '附录 C',
      '证据明细',
      `<p class="sentence">以下内容用于审计追溯，保留经脱敏和格式清理后的完整测试输入与被测对象回答原文，按风险编号排列。</p>${evidenceAppendixHtml(model.riskItemsBySeverity)}`,
      'appendix evidence-appendix newpage',
    );
  }

  // 多轮红队记录（沿用，移入附录）
  if (has('redTeam') && model.redTeam) {
    const rt = model.redTeam;
    const stats = `<div class="rt-sum">
      <div class="rt-stat"><div class="n">${rt.stats.scenarios}</div><div class="l">攻击场景</div></div>
      <div class="rt-stat"><div class="n">${rt.stats.rounds}</div><div class="l">交互轮次</div></div>
      <div class="rt-stat"><div class="n" style="color:var(--sev-critical)">${rt.stats.broken}</div><div class="l">判定为风险</div></div>
      <div class="rt-stat"><div class="n" style="color:var(--ink-soft)">${rt.stats.defended}</div><div class="l">其余场景</div></div>
    </div>`;
    appx(
      '附录 D',
      '多轮红队纪实',
      `${stats}<p class="note">其余场景包括通过、执行异常或未判定，不统一视为安全通过；具体状态见各场景记录。</p>${rt.scenarios.map(scenarioHtml).join('')}<p class="sentence" style="font-size:9pt;color:var(--ink-faint)">${esc(rt.note)}</p>`,
    );
  }
  // 封面
  const cv = view.cover;
  const lvColor = LEVEL_HEX[cv.level.level];
  const metaRows: Array<[string, string]> = [
    ['报告编号', cv.reportId || '—'],
    ['版本号', cv.version],
    ['评估日期', cv.evalDate || model.reportDate || '—'],
    ['密级', cv.classification || '内部使用'],
    ...(model.cover?.organization ? [['检测单位', model.cover.organization] as [string, string]] : []),
    ...(model.cover?.client ? [['委托单位', model.cover.client] as [string, string]] : []),
  ];
  const coverMeta = metaRows
    .map(([k, v]) => `<div><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`)
    .join('');
  const classificationTop = model.classification
    ? `<div class="cls-banner top">${esc(model.classification)}</div>`
    : '';
  const classificationBottom = model.classification
    ? `<div class="cls-banner bottom">${esc(model.classification)}</div>`
    : '';
  const cover = `<div class="cover">
    ${classificationTop}
    <div class="cover-body">
      <div class="cover-kicker">${esc(model.cover?.kicker ?? DEFAULT_PLATFORM_TITLE_TEXT)}</div>
      <div class="accent-rule"></div>
      <h1>${esc(model.cover?.title ?? cv.title)}</h1>
      <div class="sub">评估对象：${esc(cv.objectName)}${cv.objectDetail ? `（${esc(cv.objectDetail)}）` : ''}</div>
      <div class="cover-badges"><span class="lvl-chip" style="background:${lvColor}">总体风险等级：${esc(cv.level.label)}</span>${cv.scoreHint ? `<span class="score-chip">${esc(cv.scoreHint)}</span>` : ''}</div>
    </div>
    <div class="cover-meta">${coverMeta}</div>
    ${classificationBottom}
  </div>`;

  // 声明与阅读指引 + 目录
  const statement = `<div class="front">
    ${sectionHeader('', '声明与阅读指引')}
    <h3 class="sub-h first">评估依据</h3>
    <ul class="plain">${model.basis.bases.length ? model.basis.bases.map((b) => `<li>${esc(b)}</li>`).join('') : '<li>本报告为技术检测结果，不对照国家标准条款出具结论。</li>'}</ul>
    ${model.basis.statements.map((s) => `<p>${esc(s)}</p>`).join('')}
    ${model.basis.references.length ? `<h3 class="sub-h">对照参考（国际框架，不作为合规依据）</h3><ul class="plain">${model.basis.references.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    <h3 class="sub-h">适用范围</h3>
    <p>本报告结论仅适用于本次评估的被测对象版本、配置、测试范围和时间窗口；它不构成合规认证，也不表示未发现风险的部分绝对安全。</p>
    <h3 class="sub-h">术语</h3>
    ${kvTable([
      { k: '测试项', v: '发送给被测对象的一条测试输入及其对应的判定。' },
      { k: '发现风险', v: '被测对象的回答或行为被判定为不符合安全要求。' },
      { k: '暂无法判定', v: '未得到有效回答或无法给出判定的测试项，不计为通过。' },
      { k: '智能体', v: '能够调用工具、访问文件或网络并自主完成任务的大模型应用。' },
      { k: '整改主题', v: '把同类风险归并后的一项整改工作，一次整改可同时消除多项风险。' },
      { k: '复测', v: '整改后使用同一批测试项再次评估，以验证风险是否消除。' },
    ])}
    <h3 class="sub-h">修订记录</h3>
    <table class="t"><thead><tr><th style="width:16%">版本</th><th style="width:24%">日期</th><th>说明</th></tr></thead><tbody><tr><td>${esc(cv.version)}</td><td>${esc(cv.evalDate || model.reportDate || '—')}</td><td>首次发布</td></tr></tbody></table>
    <div class="toc-block">${sectionHeader('', '目录')}<ul class="toc-list">${toc.join('')}</ul></div>
  </div>`;

  const style = reportPageStyle(`报告编号 ${esc(model.reportId || '—')}`, model.page);
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${esc(model.title)}</title><style>${style}</style></head>
<body>${cover}${statement}<div class="pb">${body.join('')}${appendixBody.join('')}</div></body></html>`;
}
