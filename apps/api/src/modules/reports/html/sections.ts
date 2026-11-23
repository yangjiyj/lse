import type { HtmlReportView, FrameworkCoverageRow, ViewListRow } from './report-view.js';
import { COVERAGE_STATUS_LABELS, FRAMEWORK_LABELS, FRAMEWORK_ORDER } from './report-view.js';
import type { HeatmapRow, RateBar, RemediationTheme, SeverityKey } from './derive.js';
import { SEVERITY_ZH, formatPercent } from './derive.js';

/** HTML 转义。 */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const SEV_HEX: Record<string, string> = {
  CRITICAL: '#B3261E',
  HIGH: '#E8590C',
  MEDIUM: '#D9A400',
  LOW: '#5B7A99',
  INFO: '#6B7280',
  UNSPECIFIED: '#6B7280',
  PASS: '#1E9E5A',
  UNDETERMINED: '#8B95A3',
};

export const LEVEL_HEX: Record<string, string> = {
  HIGH: '#B3261E',
  MEDIUM_HIGH: '#E8590C',
  MEDIUM: '#D9A400',
  LOW: '#1E9E5A',
  UNRATED: '#8B95A3',
};

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function mixWithWhite(hex: string, ratio: number): string {
  const [r, g, b] = hexToRgb(hex);
  const m = (c: number) => Math.round(255 * (1 - ratio) + c * ratio);
  return `rgb(${m(r)},${m(g)},${m(b)})`;
}

function sevPill(sev: SeverityKey, label: string): string {
  const dark = sev === 'MEDIUM' ? 'color:#3A2A00;' : '';
  return `<span class="sev-pill" style="background:${SEV_HEX[sev]};${dark}">${esc(label)}</span>`;
}

// ───────────────────────────── 热力图 ─────────────────────────────

export function heatmapHtml(
  rows: HeatmapRow[],
  opts: { maxRows?: number; compact?: boolean } = {},
): string {
  if (rows.length === 0) return '';
  let shown = rows;
  let rest: HeatmapRow | null = null;
  if (opts.maxRows && rows.length > opts.maxRows) {
    shown = rows.slice(0, opts.maxRows - 1);
    const others = rows.slice(opts.maxRows - 1);
    rest = {
      domain: 'general_safety',
      label: `其他 ${others.length} 类`,
      counts: {
        CRITICAL: others.reduce((s, r) => s + r.counts.CRITICAL, 0),
        HIGH: others.reduce((s, r) => s + r.counts.HIGH, 0),
        MEDIUM: others.reduce((s, r) => s + r.counts.MEDIUM, 0),
        LOW: others.reduce((s, r) => s + r.counts.LOW, 0),
      },
      total: others.reduce((s, r) => s + r.total, 0),
    };
  }
  const all = rest ? [...shown, rest] : shown;
  const max = Math.max(1, ...all.flatMap((r) => Object.values(r.counts)));
  const cols: Array<'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'> = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
  const cell = (sev: (typeof cols)[number], n: number): string => {
    if (n === 0) return '<td class="hz"></td>';
    const ratio = 0.3 + 0.7 * Math.min(1, n / max);
    const bg = mixWithWhite(SEV_HEX[sev]!, ratio);
    const light = ratio > 0.55 && sev !== 'MEDIUM';
    return `<td class="hc" style="background:${bg};color:${light ? '#fff' : '#18222E'}">${n}</td>`;
  };
  const body = all
    .map(
      (r) =>
        `<tr><th class="hl">${esc(r.label)}</th>${cols.map((c) => cell(c, r.counts[c])).join('')}<td class="ht">${r.total}</td></tr>`,
    )
    .join('');
  const totals = cols.map((c) => all.reduce((s, r) => s + r.counts[c], 0));
  const grand = totals.reduce((a, b) => a + b, 0);
  return `<table class="heat${opts.compact ? ' compact' : ''}"><thead><tr><th class="hl">风险类别</th>${cols
    .map((c) => `<th>${SEVERITY_ZH[c]}</th>`)
    .join(
      '',
    )}<th>合计</th></tr></thead><tbody>${body}</tbody><tfoot><tr><th class="hl">合计</th>${totals
    .map((t) => `<td class="ht">${t}</td>`)
    .join('')}<td class="ht">${grand}</td></tr></tfoot></table>`;
}

// ───────────────────────────── 管理层摘要 ─────────────────────────────

export function execSummaryHtml(view: HtmlReportView): string {
  const { exec, cover } = view;
  const lvlColor = LEVEL_HEX[cover.level.level]!;
  const pr = cover.passRate;
  const scoreCell =
    pr && pr.valid > 0
      ? `<div class="sc-num">${Math.round((pr.passed / pr.valid) * 1000) / 10}<small>%</small></div><div class="sc-cap">有效判定通过率（${pr.passed} / ${pr.valid}）${cover.scoreHint ? `<br>${esc(cover.scoreHint)}` : ''}</div>`
      : cover.scoreHint
        ? `<div class="sc-hint">${esc(cover.scoreHint).replace('，', '<br>')}</div>`
        : '';
  const band = `<table class="band"><tr>
    <td class="band-level" style="background:${lvlColor}"><div class="bl-cap">总体风险等级</div><div class="bl-val"${cover.level.label.length > 2 ? ' style="font-size:19pt;padding:7px 0"' : ''}>${esc(cover.level.label)}</div></td>
    <td class="band-score">${scoreCell}</td>
    <td class="band-reason"><div class="br-h">等级依据</div><div>${esc(cover.level.reason)}。等级规则见附录 A。</div></td>
  </tr></table>`;
  const concl = `<ol class="concl">${exec.sentences.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`;
  const cards = `<table class="cards"><tr>${exec.cards
    .map(
      (c) =>
        `<td class="kc ${c.tone}"><div class="kc-l">${esc(c.label)}</div><div class="kc-v">${esc(c.value)}</div><div class="kc-s">${esc(c.sub)}</div></td>`,
    )
    .join('')}</tr></table>`;
  const top = exec.topThemes.length
    ? `<h3 class="sub-h">最需要先处理的 ${exec.topThemes.length} 件事</h3><table class="top3">${exec.topThemes
        .map(
          (t, i) =>
            `<tr><td class="t3n">${i + 1}</td><td class="t3b"><b>${esc(t.name)}</b><div class="t3s">${esc(t.priority)} · 工作量${esc(t.effortLabel)}（${esc(t.effortRange)}）· ${esc(t.domainLabels.slice(0, 3).join('、'))}</div></td><td class="t3r">可消除 <b>${t.count}</b> 项风险<div class="t3s">占全部发现的 ${formatPercent(t.share, 0)}</div></td></tr>`,
        )
        .join('')}</table>`
    : '';
  let visual = '';
  if (exec.heatmap.length) {
    visual = `<h3 class="sub-h">风险热力图（风险类别 × 严重度，单元格为风险项数）</h3>${heatmapHtml(exec.heatmap, { maxRows: 9, compact: true })}`;
  } else if (exec.severityOnly.length) {
    visual = `<h3 class="sub-h">严重度分布</h3>${severityBarsHtml(
      exec.severityOnly,
      exec.severityOnly.reduce((s, r) => s + r.count, 0),
    )}`;
  }
  return `${band}${concl}${cards}${top}${visual}`;
}

// ───────────────────────────── 结果总览 ─────────────────────────────

export function compositionHtml(view: HtmlReportView): string {
  const { composition, n } = view.overview;
  const total = Math.max(
    1,
    composition.reduce((s, c) => s + c.count, 0),
  );
  const W = 680;
  let x = 0;
  const colorOf = (k: string) =>
    k === 'pass' ? SEV_HEX.PASS : k === 'risk' ? SEV_HEX.HIGH : SEV_HEX.UNDETERMINED;
  const segs = composition
    .filter((c) => c.count > 0)
    .map((c) => {
      const w = (c.count / total) * W;
      const out = `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="34" fill="${colorOf(c.key)}"/>${
        w >= 34
          ? `<text x="${(x + w / 2).toFixed(1)}" y="22" text-anchor="middle" fill="#fff" font-size="13" font-weight="700">${c.count}</text>`
          : ''
      }`;
      x += w;
      return out;
    })
    .join('');
  const legend = composition
    .map(
      (c) =>
        `<tr><td class="lg-chip"><i style="background:${colorOf(c.key)}"></i></td><td>${esc(c.label)}</td><td class="num">${c.count} 项</td><td class="num">${formatPercent(c.count / total, 1)}</td>${
          c.key === 'undetermined' && c.count > 0
            ? `<td class="lg-note">${esc(view.overview.undeterminedDetail)}</td>`
            : '<td></td>'
        }</tr>`,
    )
    .join('');
  return `<svg class="stackbar" viewBox="0 0 ${W} 34" width="100%" preserveAspectRatio="none" role="img" aria-label="判定构成">${segs}</svg>
    <table class="legend-t">${legend}<tr class="lg-sum"><td></td><td>测试项合计</td><td class="num">${n} 项</td><td class="num">100%</td><td></td></tr></table>`;
}

export function severityBarsHtml(
  rows: Array<{ key: SeverityKey; label: string; count: number }>,
  total: number,
): string {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return `<table class="bars">${rows
    .map(
      (r) =>
        `<tr><td class="bl">${esc(r.label)}</td><td class="bt"><div class="bf" style="width:${((r.count / max) * 100).toFixed(1)}%;background:${SEV_HEX[r.key]}"></div></td><td class="bn">${r.count} 项 · ${formatPercent(total > 0 ? r.count / total : 0, 1)}</td></tr>`,
    )
    .join('')}</table>`;
}

export function rateBarsHtml(bars: RateBar[], basis: 'domain' | 'module' | 'count'): string {
  if (!bars.length) return '';
  const maxFound = Math.max(1, ...bars.map((b) => b.found));
  return `<table class="bars">${bars
    .map((b) => {
      const w =
        basis === 'count' || b.rate === null
          ? (b.found / maxFound) * 100
          : Math.max(b.rate * 100, b.found > 0 ? 1.5 : 0);
      const color = b.smallSample
        ? '#A9B2BD'
        : b.rate !== null && b.rate >= 0.5
          ? SEV_HEX.CRITICAL
          : b.rate !== null && b.rate >= 0.25
            ? SEV_HEX.HIGH
            : SEV_HEX.LOW;
      const text =
        basis === 'count'
          ? `${b.found} 项`
          : b.tested === null
            ? '未取得有效结果'
            : `${b.found} / ${b.tested} · ${formatPercent(b.rate, 1)}`;
      return `<tr><td class="bl wide">${esc(b.label)}</td><td class="bt"><div class="bf" style="width:${w.toFixed(1)}%;background:${basis === 'count' ? SEV_HEX.LOW : color}"></div></td><td class="bn">${esc(text)}${b.smallSample ? '<div class="small-note">样本少，仅供参考</div>' : ''}</td></tr>`;
    })
    .join('')}</table>`;
}

export function coverageHtml(rows: FrameworkCoverageRow[]): string {
  const statusCls: Record<FrameworkCoverageRow['status'], string> = {
    NOT_TESTED: 'cv-none',
    TESTED_CLEAN: 'cv-clean',
    TESTED_FINDINGS: 'cv-find',
    NOT_SUPPORTED: 'cv-ns',
  };
  return FRAMEWORK_ORDER.map((fw) => {
    const list = rows.filter((r) => r.framework === fw);
    if (!list.length) return '';
    return `<h4 class="fw-h">${esc(FRAMEWORK_LABELS[fw])}</h4><table class="t cov"><colgroup><col style="width:12%"><col><col style="width:12%"><col style="width:13%"><col style="width:25%"></colgroup><thead><tr><th>条目</th><th>名称</th><th class="c">已测题数</th><th class="c">发现风险数</th><th>状态</th></tr></thead><tbody>${list
      .map(
        (r) =>
          `<tr class="${r.status === 'NOT_SUPPORTED' ? 'cv-row-ns' : ''}"><td>${esc(r.entryId)}</td><td>${esc(r.entryName)}</td><td class="c num">${r.tested}</td><td class="c num">${r.failed}</td><td><span class="cv ${statusCls[r.status]}">${esc(COVERAGE_STATUS_LABELS[r.status])}</span>${r.tested > 0 && !r.sampleAdequate ? '<span class="small-note"> 样本少</span>' : ''}${r.note ? `<div class="small-note">${esc(r.note)}</div>` : ''}</td></tr>`,
      )
      .join('')}</tbody></table>`;
  }).join('');
}

// ───────────────────────────── 整改计划 ─────────────────────────────

const PRI_META: Record<'P0' | 'P1' | 'P2', { label: string; when: string; color: string }> = {
  P0: { label: 'P0 · 立即', when: '72 小时内', color: SEV_HEX.CRITICAL! },
  P1: { label: 'P1 · 短期', when: '两周内', color: SEV_HEX.HIGH! },
  P2: { label: 'P2 · 本季度', when: '本季度内', color: SEV_HEX.MEDIUM! },
};

export function roadmapHtml(roadmap: Record<'P0' | 'P1' | 'P2', RemediationTheme[]>): string {
  const phaseFor = (p: 'P0' | 'P1' | 'P2'): '立即' | '短期' | '中期' =>
    p === 'P0' ? '立即' : p === 'P1' ? '短期' : '中期';
  const cell = (p: 'P0' | 'P1' | 'P2'): string => {
    const list = roadmap[p];
    if (!list.length) return '<div class="rm-empty">本次无对应整改主题</div>';
    return list
      .map((t) => {
        const step = t.steps.find((s) => s.phase === phaseFor(p)) ?? t.steps[0];
        return `<div class="rm-item"><div class="rm-n"><b>${esc(t.name)}</b></div><div class="rm-m">${t.count} 项 · 工作量${esc(t.effortLabel)}</div>${step ? `<div class="rm-s">${esc(step.text)}</div>` : ''}</div>`;
      })
      .join('');
  };
  return `<table class="t roadmap"><thead><tr>${(['P0', 'P1', 'P2'] as const)
    .map(
      (p) =>
        `<th style="background:${PRI_META[p].color};${p === 'P2' ? 'color:#3A2A00;' : ''}">${PRI_META[p].label}<small>${PRI_META[p].when}</small></th>`,
    )
    .join(
      '',
    )}</tr></thead><tbody><tr>${(['P0', 'P1', 'P2'] as const).map((p) => `<td>${cell(p)}</td>`).join('')}</tr></tbody></table>`;
}

export function themeCardsHtml(themes: RemediationTheme[], leadHtml = ''): string {
  return themes
    .map((t, idx) => {
      const ids =
        t.findingIds.length > 14
          ? `${t.findingIds.slice(0, 14).join('、')} 等 ${t.findingIds.length} 项`
          : t.findingIds.join('、');
      const lead = idx === 0 ? leadHtml : '';
      return `${lead ? '<div class="keep">' + lead : ''}<div class="theme" style="border-left-color:${PRI_META[t.priority].color}">
      <div class="th-head"><span class="th-rank">${t.rank}</span><span class="th-name">${esc(t.name)}</span><span class="th-pri" style="background:${PRI_META[t.priority].color};${t.priority === 'P2' ? 'color:#3A2A00;' : ''}">${t.priority}</span></div>
      <div class="th-kpi">可消除 <b>${t.count}</b> 项风险（占全部发现的 ${formatPercent(t.share, 0)}）　·　工作量：${esc(t.effortLabel)}（${esc(t.effortRange)}）　·　优先级 ${t.priority}，${PRI_META[t.priority].when}启动</div>
      <div class="th-row"><span class="th-k">要解决的问题</span>${esc(t.problem)}</div>
      <div class="th-row"><span class="th-k">为什么重要</span>${esc(t.why)}</div>
      <div class="th-row"><span class="th-k">怎么做</span></div>
      <ol class="th-steps">${t.steps.map((s) => `<li><em>${s.phase}</em>${esc(s.text)}</li>`).join('')}</ol>
      <div class="th-row"><span class="th-k">建议责任角色</span>${esc(t.owner)}</div>
      <div class="th-row"><span class="th-k">验收标准</span>${esc(t.acceptance)}</div>
      <div class="th-row th-ref"><span class="th-k">关联风险编号</span>${esc(ids)}　<span class="th-k">参考</span>${esc(t.references.join('；'))}</div>
    </div>${lead ? '</div>' : ''}`;
    })
    .join('');
}

export function trackingTableHtml(themes: RemediationTheme[]): string {
  const rows = themes
    .map(
      (t, i) =>
        `<tr class="blank"><td class="c">R-${String(i + 1).padStart(2, '0')}</td><td>${esc(t.name)}<div class="small-note">关联 ${t.count} 项 · ${t.priority}</div></td><td></td><td></td><td></td><td></td></tr>`,
    )
    .join('');
  return `<table class="t track"><colgroup><col style="width:9%"><col style="width:34%"><col style="width:15%"><col style="width:15%"><col style="width:13%"><col style="width:14%"></colgroup><thead><tr><th>编号</th><th>整改主题</th><th>责任人</th><th>计划完成日</th><th>状态</th><th>复测结果</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ───────────────────────────── 发现清单 ─────────────────────────────

export function findingTableHtml(rows: ViewListRow[], hasAppendix: boolean): string {
  if (!rows.length) return '';
  const idCell = (r: ViewListRow): string => {
    const ids =
      r.evidenceIds.length > 4
        ? [...r.evidenceIds.slice(0, 3), `…共${r.evidenceIds.length}项`]
        : r.evidenceIds;
    if (!hasAppendix) return esc(ids.join('、'));
    return ids
      .map((id, i) =>
        r.anchors[i]
          ? `<a class="evidence-link" href="#${esc(r.anchors[i])}">${esc(id)}</a>`
          : esc(id),
      )
      .join('、');
  };
  return `<table class="t flist"><colgroup><col style="width:13%"><col style="width:15%"><col style="width:12%"><col style="width:8%"><col style="width:34%"><col style="width:5%"><col style="width:13%"></colgroup><thead><tr><th>编号</th><th>风险标题</th><th>风险类别</th><th>严重度</th><th>一句话问题</th><th class="c">题数</th><th>证据编号</th></tr></thead><tbody>${rows
    .map(
      (r) =>
        `<tr><td class="num">${esc(r.id)}</td><td>${esc(r.title)}</td><td>${esc(r.domainLabel)}</td><td>${sevPill(r.severity, r.severityLabel)}</td><td>${esc(r.summary)}</td><td class="c num">${r.count}</td><td class="small">${idCell(r)}</td></tr>`,
    )
    .join('')}</tbody></table>`;
}

/** 第 6 章：按框架汇总覆盖状态的条目数。 */
export function coverageSummaryTableHtml(rows: FrameworkCoverageRow[]): string {
  const body = FRAMEWORK_ORDER.map((fw) => {
    const list = rows.filter((r) => r.framework === fw);
    if (!list.length) return '';
    const c = (st: FrameworkCoverageRow['status']) => list.filter((r) => r.status === st).length;
    return `<tr><td>${esc(FRAMEWORK_LABELS[fw])}</td><td class="c num">${list.length}</td><td class="c num">${c('TESTED_FINDINGS')}</td><td class="c num">${c('TESTED_CLEAN')}</td><td class="c num">${c('NOT_TESTED')}</td><td class="c num">${c('NOT_SUPPORTED')}</td></tr>`;
  }).join('');
  return `<table class="t cov-sum"><colgroup><col style="width:42%"><col style="width:10%"><col style="width:12%"><col style="width:12%"><col style="width:12%"><col style="width:12%"></colgroup><thead><tr><th>框架</th><th class="c">条目数</th><th class="c">已测 · 发现风险</th><th class="c">已测 · 未发现风险</th><th class="c">未测试</th><th class="c">平台暂不覆盖</th></tr></thead><tbody>${body}</tbody></table>`;
}

export const SECTIONS_CSS = `
.sc-hint{ font-size:12pt; font-weight:800; color:var(--ink-soft); line-height:1.3; }
tr.cv-row-ns td{ color:#7A8490; }
.cv-ns{ background:#F4F5F7 !important; color:#6B7280 !important; border:1px dashed #9AA3AE; }
table.cov-sum th, table.cov-sum td{ font-size:8pt; padding:4px 6px; }
/* 续页表格不会重复表头，列宽必须写在每个单元格上 */
table.flist th:nth-child(1),table.flist td:nth-child(1){ width:13%; }
table.flist th:nth-child(2),table.flist td:nth-child(2){ width:15%; }
table.flist th:nth-child(3),table.flist td:nth-child(3){ width:12%; }
table.flist th:nth-child(4),table.flist td:nth-child(4){ width:8%; }
table.flist th:nth-child(5),table.flist td:nth-child(5){ width:34%; }
table.flist th:nth-child(6),table.flist td:nth-child(6){ width:5%; }
table.flist th:nth-child(7),table.flist td:nth-child(7){ width:13%; }
table.track th:nth-child(1),table.track td:nth-child(1){ width:9%; }
table.track th:nth-child(2),table.track td:nth-child(2){ width:34%; }
table.track th:nth-child(3),table.track td:nth-child(3){ width:15%; }
table.track th:nth-child(4),table.track td:nth-child(4){ width:15%; }
table.track th:nth-child(5),table.track td:nth-child(5){ width:13%; }
table.track th:nth-child(6),table.track td:nth-child(6){ width:14%; }
table.cov th:nth-child(1),table.cov td:nth-child(1){ width:12%; }
table.cov th:nth-child(3),table.cov td:nth-child(3){ width:12%; }
table.cov th:nth-child(4),table.cov td:nth-child(4){ width:13%; }
table.cov th:nth-child(5),table.cov td:nth-child(5){ width:25%; }
.sub-h{ font-size:10.5pt; margin:10px 0 5px; color:var(--brand-deep); break-after:avoid; }
.sub-h.first{ margin-top:2px; }
.fw-h{ font-size:9.5pt; margin:10px 0 4px; color:var(--brand-deep); break-after:avoid; }
.small-note{ font-size:7.5pt; color:var(--ink-faint); }
.small{ font-size:8pt; }
.num{ font-variant-numeric:tabular-nums; }
/* 管理层摘要 */
table.band{ width:100%; border-collapse:collapse; table-layout:fixed; margin:2px 0 8px; }
table.band td{ vertical-align:middle; padding:0; }
td.band-level{ width:44mm; color:#fff; text-align:center; padding:8px 6px; }
.bl-cap{ font-size:9pt; letter-spacing:.1em; opacity:.95; }
.bl-val{ font-size:30pt; font-weight:800; line-height:1.1; }
td.band-score{ width:40mm; text-align:center; background:var(--zebra); border-top:1px solid var(--hairline); border-bottom:1px solid var(--hairline); }
.sc-num{ font-size:26pt; font-weight:800; line-height:1.1; color:var(--ink); }
.sc-num small{ font-size:11pt; font-weight:600; color:var(--ink-faint); }
.sc-cap{ font-size:8.5pt; color:var(--ink-soft); }
td.band-reason{ padding:8px 12px; background:var(--zebra); border:1px solid var(--hairline); border-left:none; font-size:9.5pt; color:var(--ink-soft); }
.br-h{ font-weight:700; color:var(--ink); margin-bottom:2px; }
ol.concl{ margin:4px 0 8px; padding-left:5mm; font-size:10pt; line-height:1.65; }
ol.concl li{ margin:0 0 3px; padding-left:1mm; overflow-wrap:anywhere; }
table.cards{ width:100%; border-collapse:separate; border-spacing:2.5mm 0; table-layout:fixed; margin:0 -2.5mm 6px; width:calc(100% + 5mm); }
td.kc{ border:1px solid var(--hairline); border-top:3px solid var(--ink-faint); padding:6px 7px 6px; vertical-align:top; background:#fff; }
td.kc.bad{ border-top-color:var(--sev-high); } td.kc.warn{ border-top-color:#8B95A3; } td.kc.good{ border-top-color:var(--pass); }
.kc-l{ font-size:8.5pt; color:var(--ink-soft); font-weight:600; }
.kc-v{ font-size:22pt; font-weight:800; line-height:1.15; }
.kc-s{ font-size:7.5pt; color:var(--ink-faint); line-height:1.4; overflow-wrap:anywhere; }
table.top3{ width:100%; border-collapse:collapse; table-layout:fixed; }
table.top3 td{ padding:5px 7px; border-bottom:1px solid var(--hairline); vertical-align:middle; }
td.t3n{ width:8mm; font-size:15pt; font-weight:800; color:var(--brand); text-align:center; }
td.t3r{ width:46mm; text-align:right; font-size:9.5pt; } td.t3r b{ font-size:14pt; color:var(--sev-critical); }
.t3s{ font-size:7.8pt; color:var(--ink-faint); overflow-wrap:anywhere; }
td.t3b{ font-size:10pt; overflow-wrap:anywhere; }
/* 热力图 */
table.heat{ width:100%; border-collapse:separate; border-spacing:1.5px; table-layout:fixed; font-size:9pt; }
table.heat th{ font-weight:600; font-size:8.5pt; color:var(--ink-soft); padding:3px 4px; text-align:center; }
table.heat th.hl{ text-align:left; width:38%; }
table.heat tbody th.hl{ font-weight:500; color:var(--ink); padding:2px 6px; overflow-wrap:anywhere; background:var(--zebra); }
table.heat td{ text-align:center; padding:1px 3px; height:5mm; }
table.heat.compact td{ height:5.6mm; padding:2px 3px; } table.heat.compact tbody th.hl{ padding:2px 6px; font-size:8.5pt; }
table.heat td.hz{ background:#F1F3F5; }
table.heat td.hc{ font-weight:700; }
table.heat td.ht{ font-weight:700; background:#fff; border:1px solid var(--hairline); }
table.heat tfoot th.hl{ background:#fff; font-weight:700; }
/* 总览图表 */
svg.stackbar{ display:block; height:11mm; border-radius:3px; }
table.legend-t{ width:100%; border-collapse:collapse; font-size:9pt; margin-top:5px; }
table.legend-t td{ padding:3px 6px; border-bottom:1px solid var(--hairline); }
table.legend-t td.num{ text-align:right; width:22mm; white-space:nowrap; }
td.lg-chip{ width:6mm; } td.lg-chip i{ display:inline-block; width:3.4mm; height:3.4mm; border-radius:1px; }
td.lg-note{ font-size:8pt; color:var(--ink-faint); }
tr.lg-sum td{ font-weight:700; border-bottom:none; }
table.bars{ width:100%; border-collapse:collapse; table-layout:fixed; font-size:9pt; }
table.bars td{ padding:3px 5px; vertical-align:middle; }
td.bl{ width:22mm; } td.bl.wide{ width:48mm; overflow-wrap:anywhere; }
td.bt{ background:none; } td.bt .bf{ height:4.2mm; border-radius:2px; min-width:1px; }
td.bt{ border-bottom:1px solid #EEF1F5; }
td.bn{ width:42mm; white-space:normal; color:var(--ink-soft); }
table.cov td, table.cov th{ font-size:8pt; padding:3px 6px; }
.cv{ display:inline-block; padding:0 6px; border-radius:3px; font-size:7.8pt; font-weight:600; }
.cv-none{ background:#EEF0F3; color:#5B6573; } .cv-clean{ background:var(--pass-bg); color:var(--pass); }
.cv-find{ background:var(--sev-high-bg); color:var(--sev-critical); } .cv-ns{ background:#F4ECD8; color:#8A6A1F; }
/* 整改 */
table.roadmap th{ text-align:center; color:#fff; padding:7px 6px; font-size:10pt; } table.roadmap th small{ display:block; font-weight:400; font-size:8pt; opacity:.95; }
table.roadmap td{ width:33.3%; vertical-align:top; padding:6px 8px; border-right:1px solid var(--hairline); }
.rm-item{ margin-bottom:7px; padding-bottom:6px; border-bottom:1px dashed var(--hairline); }
.rm-item:last-child{ border-bottom:none; }
.rm-n{ font-size:9.5pt; } .rm-m{ font-size:8pt; color:var(--ink-faint); } .rm-s{ font-size:8.3pt; color:var(--ink-soft); margin-top:2px; overflow-wrap:anywhere; }
.rm-empty{ color:var(--ink-faint); font-size:9pt; padding:8px 0; text-align:center; }
.theme{ border:1px solid var(--hairline); border-left:5px solid var(--brand); border-radius:0 6px 6px 0; padding:9px 12px 8px; margin:8px 0 10px; break-inside:avoid; }
.th-head{ margin-bottom:3px; break-after:avoid; }
.th-rank{ display:inline-block; width:6mm; height:6mm; line-height:6mm; text-align:center; background:var(--brand-deep); color:#fff; border-radius:50%; font-weight:700; font-size:9pt; margin-right:6px; }
.th-name{ font-size:11.5pt; font-weight:700; }
.th-pri{ display:inline-block; margin-left:8px; padding:0 8px; border-radius:3px; color:#fff; font-size:8.5pt; font-weight:700; }
.th-kpi{ font-size:8.8pt; color:var(--ink-soft); background:var(--zebra); padding:3px 8px; margin:3px 0 5px; } .th-kpi b{ color:var(--sev-critical); font-size:10.5pt; }
.th-row{ font-size:9pt; line-height:1.6; margin:2px 0; overflow-wrap:anywhere; }
.th-k{ display:inline-block; font-weight:700; color:var(--brand-deep); margin-right:6px; }
ol.th-steps{ margin:1px 0 3px; padding-left:6mm; font-size:9pt; line-height:1.55; }
ol.th-steps li{ margin:1px 0; overflow-wrap:anywhere; } ol.th-steps em{ font-style:normal; font-size:8pt; font-weight:700; color:#fff; background:var(--brand); padding:0 5px; border-radius:3px; margin-right:5px; }
.th-ref{ font-size:8pt; color:var(--ink-faint); }
table.track tr.blank td{ height:11mm; } table.track td.c{ text-align:center; }
table.kvt td:first-child{ width:24mm; font-weight:700; color:var(--brand-deep); background:var(--zebra); }
table.flist td{ font-size:7.8pt; padding:3px 5px; line-height:1.4; } table.flist th{ font-size:8pt; padding:4px 5px; }
table.flist .sev-pill{ font-size:7.5pt; padding:0 6px; }
ul.plain{ margin:3px 0 8px; padding-left:5mm; font-size:9.5pt; } ul.plain li{ margin:2px 0; overflow-wrap:anywhere; }
.one-page{ break-after:page; }
.keep{ break-inside:avoid; }
.pgbreak{ break-before:page; }
.note-box{ font-size:8.5pt; color:var(--ink-soft); background:var(--accent-soft); border-left:3px solid var(--accent-deep); padding:5px 10px; margin:6px 0; overflow-wrap:anywhere; }
`;
