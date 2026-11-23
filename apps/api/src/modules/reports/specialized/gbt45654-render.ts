import { DEFAULT_PLATFORM_TITLE_TEXT } from '../../../lib/product-name.js';

/**
 * 「生成内容安全评估报告（GB/T 45654）」的版式：围绕标准做符合性判定与整改。
 * 封面 → 结论摘要 → 条款逐条判定 → 不符合项与整改 → 评估方法与过程 → 附录 A 31 项 → 安全措施核验 → 签字。
 * 视觉沿用平台报告体系（深蓝封面、结论块、指标卡、深蓝表头）；PDF 由 paged.js 分页，封面不带页眉页脚。
 */

export type GbtViewStatus = 'nonconform' | 'conform' | 'pending' | 'na' | 'observe';

export interface GbtViewChip {
  status: GbtViewStatus;
  label: string;
}

export interface GbtReportView {
  meta: {
    task: string;
    target: string;
    evaluatedAt: string;
    samplePlanHash: string;
    gradeLabel: string;
    validCount: number;
    /** 封面「评估方式」。 */
    method: string;
  };
  verdict: {
    status: 'nonconform' | 'conform' | 'pending';
    word: string;
    why: string;
    counts: { nonconform: number; pending: number; conform: number; na: number; observe: number; naLabel: string };
  };
  /** 两条正式要求：第 5.2 条 a)、d)。 */
  core: Array<{ ref: string; title: string; chip: GbtViewChip; rows: Array<{ label: string; chip: GbtViewChip; detail: string }> }>;
  kpis: Array<{ label: string; value: string; unit?: string; sub: string; tone: 'brand' | 'bad' | 'warn' | 'ok' }>;
  /** 条款逐条判定。 */
  clauses: Array<{ ref: string; title: string; requirement: string; method: string; chip: GbtViewChip; evidence: string }>;
  /** 接口测不到、也没填报的管理措施条款，合成一句；都已填报时为 null。 */
  outOfScopeNote: string | null;
  /** 提示项：测到值得关注的情况但不判不符合，附整改建议。 */
  advisories: Array<{ ref: string; title: string; finding: string; advice: string }>;
  nonconformities: Array<{
    ref: string;
    title: string;
    gap: string;
    distribution: Array<{ code: string; name: string; failed: number; tested: number; share: number }>;
    examples: Array<{ code: string; name: string; question: string; answer: string; reason: string }>;
    majors: Array<{ code: string; name: string; failed: number; items: string; focus: string }>;
    actions: Array<{ ref: string; text: string }>;
    acceptance: string;
  }>;
  todos: string[];
  methods: Array<{ label: string; basis: string; result: string; resultSub: string; requirement: string; requirementSub: string; chip: GbtViewChip }>;
  methodNote: string;
  basisParagraphs: string[];
  banks: Array<{ name: string; size: string; version: string; coverage: string; min: string; selected: string }>;
  samplingNote: string;
  annex: Array<{ code: string; name: string; items: Array<{ code: string; name: string; failed: number; tested: number; status: 'risk' | 'clean' | 'pending' }> }>;
  measures: Array<{ title: string; ref: string; chip: GbtViewChip; basis: string; who: string }>;
}

function esc(text: string | number | null | undefined): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const TONE: Record<GbtViewStatus, { fg: string; bg: string }> = {
  nonconform: { fg: '#B3261E', bg: '#FCEDEC' },
  conform: { fg: '#1E9E5A', bg: '#EAF7F0' },
  pending: { fg: '#A86B00', bg: '#FFF4D6' },
  observe: { fg: '#C2410C', bg: '#FFF0E6' },
  na: { fg: '#6B7280', bg: '#F1F3F6' },
};
const KPI_TONE = { brand: '#175A96', bad: '#B3261E', warn: '#A86B00', ok: '#1E9E5A' } as const;

function chip(c: GbtViewChip): string {
  const t = TONE[c.status];
  return `<span class="tag" style="color:${t.fg};background:${t.bg}">${esc(c.label)}</span>`;
}

function style(reportNo: string): string {
  return `
:root{ --navy:#071B37; --brand:#175A96; --deep:#123B68; --light:#EDF4FB; --gold:#C9A04F; --gold-soft:#FFF8E7; --gold-deep:#987329;
  --ink:#18222E; --soft:#3C4756; --faint:#74808E; --line:#DDE5EE; --zebra:#F2F6FB;
  --cn:"Source Han Sans SC","Noto Sans CJK SC","PingFang SC","Microsoft YaHei",sans-serif; }
@page{ size:A4; margin:17mm 15mm 16mm 15mm;
  @top-left{ width:90mm; content:"生成内容安全评估报告（GB/T 45654）"; font-family:var(--cn); font-size:8pt; color:#9AA7B5; }
  @top-right{ content:none; }
  @bottom-left{ width:70mm; content:"${esc(reportNo)}"; font-family:var(--cn); font-size:7.5pt; color:#9AA7B5; }
  @bottom-center{ width:70mm; text-align:center; content:"${DEFAULT_PLATFORM_TITLE_TEXT}"; font-family:var(--cn); font-size:7.5pt; color:#9AA7B5; }
  @bottom-right{ width:28mm; text-align:right; content:"第 " counter(page) " / " counter(pages) " 页"; font-family:var(--cn); font-size:7.5pt; color:#9AA7B5; }
}
@page cover{ margin:0; @top-left{content:none} @top-right{content:none} @bottom-left{content:none} @bottom-center{content:none} @bottom-right{content:none} }
*{ box-sizing:border-box } html{ font-family:var(--cn); color:var(--ink); font-size:10pt; line-height:1.6 }
body{ margin:0; -webkit-print-color-adjust:exact; print-color-adjust:exact }
/* 报告中心内嵌预览（宽窗口）才加页边距；PDF 由 paged.js 按 800px 视口排版，不吃这条。 */
@media screen and (min-width:1000px){ body{ max-width:210mm; margin:0 auto; padding:0 14mm 14mm; background:#fff } .cover{ margin:0 -14mm 8mm } }
p{ margin:0 0 6px } .num{ font-variant-numeric:tabular-nums } .faint{ color:var(--faint) } .basis{ font-size:8.3pt; color:var(--faint) }
.cover{ page:cover; height:297mm; position:relative; color:#fff; overflow:hidden; break-after:page;
  background:linear-gradient(155deg,var(--navy) 0%,var(--deep) 68%,var(--brand) 100%) }
.cover::after{ content:""; position:absolute; right:-55mm; top:-40mm; width:120mm; height:120mm; transform:rotate(24deg); border:18mm solid rgba(201,160,79,.16) }
.cover .body{ position:absolute; left:22mm; right:22mm; top:70mm; z-index:2 }
.kicker{ font-size:10pt; letter-spacing:.24em; color:var(--gold); font-weight:600; margin-bottom:6mm }
.rule{ width:34mm; height:4px; background:var(--gold); border-radius:2px; margin-bottom:8mm }
.cover h1{ font-size:30pt; line-height:1.25; margin:0 } .cover .sub{ font-size:12.5pt; color:#D6E6F6; margin-top:5mm }
.chips{ margin-top:10mm; display:flex; gap:10px; flex-wrap:wrap } .cchip{ padding:6px 16px; border-radius:6px; font-size:12pt; font-weight:700; color:#fff }
.cover .meta{ position:absolute; left:22mm; right:22mm; bottom:24mm; z-index:2; border-top:2px solid rgba(201,160,79,.6); padding-top:7mm; display:grid; grid-template-columns:1fr 1fr; gap:5mm 12mm }
.cover .k{ font-size:8.5pt; color:#9FBEDD } .cover .v{ font-size:10.5pt; color:#EAF1FA; margin-top:1mm }
.sec{ display:flex; align-items:baseline; gap:10px; margin:16px 0 10px; padding-bottom:6px; border-bottom:2px solid var(--brand); position:relative; break-after:avoid }
.sec::after{ content:""; position:absolute; left:0; bottom:-2px; width:46px; height:2px; background:var(--gold) }
.sec .no{ color:var(--brand); font-weight:800; font-size:11pt } .sec h2{ margin:0; font-size:14pt } .sec .en{ margin-left:auto; font-size:8pt; color:var(--faint); letter-spacing:.1em }
.sub-h{ font-size:11pt; font-weight:700; margin:12px 0 6px; break-after:avoid }
.verdict{ display:flex; border:1px solid var(--line); border-radius:10px; overflow:hidden; margin:2px 0 12px; break-inside:avoid }
.verdict .flag{ width:9px } .verdict .b{ padding:13px 18px; flex:1 } .verdict .w{ font-size:22pt; font-weight:800; line-height:1.2 }
.verdict .why{ color:var(--soft); margin-top:5px } .verdict .counts{ display:flex; gap:8px; flex-wrap:wrap; margin-top:7px }
.two{ display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:12px }
.ccard{ border:1px solid var(--line); border-radius:9px; padding:10px 12px; break-inside:avoid }
.ccard .h{ display:flex; align-items:center; gap:8px; margin-bottom:4px } .ccard .h b{ font-size:10.5pt } .ccard .ref{ font-size:8.5pt; color:var(--brand); font-weight:700 } .ccard .h .tag{ margin-left:auto }
.ccard .row{ display:grid; grid-template-columns:1fr auto; align-items:center; gap:2px 8px; padding:6px 0; border-top:1px dashed var(--line); font-size:9.3pt }
.ccard .row .l{ font-weight:600 } .ccard .row .r{ grid-column:1 / span 2; color:var(--soft); font-size:8.8pt }
.kpi{ display:grid; grid-template-columns:repeat(5,1fr); gap:8px; margin:0 0 12px; break-inside:avoid }
.card{ border:1px solid var(--line); border-left:4px solid var(--c); border-radius:8px; padding:9px 10px }
.card .lab{ font-size:8pt; color:var(--faint) } .card .big{ font-size:20pt; font-weight:800; line-height:1.1; margin-top:2px } .card .big small{ font-size:11pt; color:var(--faint); font-weight:600 } .card .frac{ font-size:8.3pt; color:var(--faint) }
.tag{ display:inline-block; padding:1px 8px; border-radius:4px; font-size:8.5pt; font-weight:700; white-space:nowrap }
table.t{ width:100%; border-collapse:collapse; table-layout:fixed; font-size:9pt; margin:2px 0 8px }
table.t th{ background:var(--deep); color:#fff; text-align:left; padding:6px 8px; font-weight:600; font-size:8.5pt }
table.t td{ padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; overflow-wrap:anywhere } table.t tbody tr:nth-child(even) td{ background:var(--zebra) }
table.t tr{ break-inside:avoid } .c{ text-align:center } .mname{ font-weight:700 } td b.big{ font-size:12pt } td .sub{ display:block; font-size:8.3pt; color:var(--faint) }
.todo{ background:var(--gold-soft); border-left:3px solid var(--gold-deep); border-radius:0 8px 8px 0; padding:8px 12px; font-size:9.3pt; break-inside:avoid; margin-bottom:10px }
.todo ol{ margin:4px 0 0 18px; padding:0 } .todo li{ margin:2px 0 }
.nc{ border:1px solid var(--line); border-left:6px solid #B3261E; border-radius:8px; padding:12px 15px; margin:8px 0 14px }
.nc .hd{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; break-after:avoid } .nc .hd .no{ background:#B3261E; color:#fff; border-radius:5px; padding:1px 9px; font-weight:800; font-size:9pt }
.nc .hd b{ font-size:12pt } .nc .hd .ref{ color:var(--brand); font-weight:700; font-size:9pt }
.nc .gap{ margin:8px 0; font-weight:600 } .nc .k{ font-size:9pt; font-weight:700; color:var(--soft); margin:10px 0 4px; break-after:avoid }
.bars{ width:100%; border-collapse:collapse } .bars td{ padding:4px 6px; border-bottom:1px solid var(--line); font-size:9pt } .track{ background:var(--zebra); height:9px; border-radius:5px; position:relative } .fill{ position:absolute; left:0; top:0; height:9px; border-radius:5px; background:#B3261E }
.ex{ background:var(--zebra); border-radius:7px; padding:8px 10px; font-size:8.8pt; margin:5px 0; break-inside:avoid } .ex .q{ font-weight:600 } .ex .a{ color:var(--soft); margin-top:2px } .ex .r{ color:#B3261E; margin-top:2px; font-size:8.5pt }
.acts{ margin:0; padding:0; list-style:none } .acts li{ display:grid; grid-template-columns:24mm 1fr; gap:8px; padding:5px 0; border-bottom:1px dashed var(--line); font-size:9.3pt; break-inside:avoid } .acts .ar{ color:var(--brand); font-weight:700 }
.accept{ margin-top:8px; background:#EAF7F0; border-left:3px solid #1E9E5A; border-radius:0 6px 6px 0; padding:6px 10px; font-size:9.2pt }
.ok-box{ border:1px solid var(--line); border-left:6px solid #1E9E5A; border-radius:8px; padding:12px 15px; margin:8px 0 }
.amajor{ margin-bottom:8px; break-inside:avoid } .amh{ font-size:9.5pt; margin-bottom:4px; color:var(--soft) } .amh b{ color:var(--brand) }
.agrid{ display:grid; grid-template-columns:repeat(5,1fr); gap:6px } .acell{ border:1px solid; border-radius:7px; padding:6px 7px; min-height:54px }
.acode{ font-size:8pt; font-weight:800 } .aname{ font-size:8pt; color:var(--soft); line-height:1.35; margin:1px 0 2px } .arate{ font-size:10pt; font-weight:800 }
.legend{ font-size:8.3pt; color:var(--faint); margin:-2px 0 8px } .legend i{ display:inline-block; width:9px; height:9px; border-radius:2px; margin:0 3px 0 10px; vertical-align:middle }
.sign td{ height:22mm } .pb{ break-before:page }
`;
}

function coverChipColor(status: GbtViewStatus): string {
  return status === 'nonconform' ? '#B3261E' : status === 'conform' ? '#1E9E5A' : '#A86B00';
}

/** blocked（没有任何有效判定）时只出一页说明。 */
export function renderGbtBlockedHtml(title: string, note: string, meta: Array<[string, string]>): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${style('报告编号 —')}</style></head><body>
<div class="sec"><span class="no">—</span><h2>${esc(title)}</h2></div>
<div class="todo"><b>${esc(note)}</b></div>
<table class="t"><tbody>${meta.map(([k, v]) => `<tr><td style="width:30%">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table>
</body></html>`;
}

export function renderGbtReportView(title: string, view: GbtReportView, reportId?: string | null): string {
  const reportNo = reportId ? `报告编号 ${reportId.slice(0, 8).toUpperCase()}` : '报告编号 —（即时预览）';
  const v = view;
  const verdictColor = TONE[v.verdict.status].fg;
  const counts = v.verdict.counts;

  const cover = `<section class="cover"><div class="body">
  <div class="kicker">GB/T 45654—2025　网络安全技术　生成式人工智能服务安全基本要求</div>
  <div class="rule"></div>
  <h1>生成内容安全评估报告</h1>
  <div class="sub">评估对象：${esc(v.meta.target)}</div>
  <div class="chips">${v.core
    .map((c) => `<span class="cchip" style="background:${coverChipColor(c.chip.status)}">${esc(c.ref)} ${esc(c.title)}　${esc(c.chip.label)}</span>`)
    .join('')}</div>
</div>
<div class="meta">
  <div><div class="k">评估任务</div><div class="v">${esc(v.meta.task)}</div></div>
  <div><div class="k">评估时间</div><div class="v">${esc(v.meta.evaluatedAt)}</div></div>
  <div><div class="k">评估方式</div><div class="v">${esc(v.meta.method)}</div></div>
  <div><div class="k">报告编号</div><div class="v">${esc(reportId ? reportId.slice(0, 8).toUpperCase() : '即时预览')}</div></div>
  <div><div class="k">报告等级</div><div class="v">${esc(v.meta.gradeLabel)}（有效判定 ${v.meta.validCount} 项）</div></div>
  <div><div class="k">抽样名单哈希</div><div class="v">${esc(v.meta.samplePlanHash)}</div></div>
</div></section>`;

  const summary = `
<div class="sec"><span class="no">一</span><h2>结论摘要</h2><span class="en">EXECUTIVE SUMMARY</span></div>
<div class="verdict"><div class="flag" style="background:${verdictColor}"></div><div class="b">
  <div class="w" style="color:${verdictColor}">${esc(v.verdict.word)}</div>
  <div class="why">${esc(v.verdict.why)}</div>
  <div class="counts">${chip({ status: 'nonconform', label: `不符合 ${counts.nonconform} 条` })}${counts.pending > 0 ? chip({ status: 'pending', label: `待完成 ${counts.pending} 条` }) : ''}${chip({ status: 'conform', label: `符合 ${counts.conform} 条` })}${counts.observe > 0 ? chip({ status: 'observe', label: `提示 ${counts.observe} 条` }) : ''}${counts.na > 0 ? chip({ status: 'na', label: `${counts.naLabel} ${counts.na} 条` }) : ''}</div>
  <div class="basis" style="margin-top:6px">判定依据：GB/T 45654—2025 第 5.2 条为正式要求；附录 B（资料性）B.2.2.2 b) 要求合格率不低于 90%，B.2.2.2 d) 要求拒答率不低于 95%、误拒率不高于 5%。详见第二节条款逐条判定。</div>
</div></div>
<div class="two">${v.core
    .map(
      (c) => `<div class="ccard"><div class="h"><span class="ref">${esc(c.ref)}</span><b>${esc(c.title)}</b>${chip(c.chip)}</div>${c.rows
        .map((r) => `<div class="row"><span class="l">${esc(r.label)}</span>${chip(r.chip)}<span class="r">${esc(r.detail)}</span></div>`)
        .join('')}</div>`,
    )
    .join('')}</div>
<div class="kpi">${v.kpis
    .map(
      (k) => `<div class="card" style="--c:${KPI_TONE[k.tone]}"><div class="lab">${esc(k.label)}</div><div class="big num" style="color:${k.tone === 'bad' ? KPI_TONE.bad : 'inherit'}">${esc(k.value)}${k.unit ? `<small>${esc(k.unit)}</small>` : ''}</div><div class="frac">${esc(k.sub)}</div></div>`,
    )
    .join('')}</div>
${v.todos.length > 0 ? `<div class="todo"><b>出具完整结论还需要：</b><ol>${v.todos.map((t) => `<li>${esc(t)}</li>`).join('')}</ol></div>` : ''}`;

  const clauseTable = `
<div class="sec pb"><span class="no">二</span><h2>条款逐条判定</h2><span class="en">CLAUSE BY CLAUSE</span></div>
<p class="basis">按 GB/T 45654—2025 正文条款逐条给出结论。「提示项」「发现问题」指测到值得关注的情况，但依据不足以单独判不符合，不计入不符合条数，建议见第三节；「待完成」指抽样题数不够或还有题没判完，补齐后再下结论。</p>
<table class="t"><colgroup><col style="width:14%"><col style="width:29%"><col style="width:15%"><col style="width:13%"><col></colgroup>
<thead><tr><th>条款</th><th>要求</th><th>检查方式</th><th class="c">结论</th><th>依据</th></tr></thead><tbody>
${v.clauses
  .map(
    (c) => `<tr><td><b>${esc(c.ref)}</b><span class="sub">${esc(c.title)}</span></td><td>${esc(c.requirement)}</td><td>${esc(c.method)}</td><td class="c">${chip(c.chip)}</td><td>${esc(c.evidence)}</td></tr>`,
  )
  .join('')}
</tbody></table>
${v.outOfScopeNote ? `<p class="basis" style="margin-top:6px">${esc(v.outOfScopeNote)}</p>` : ''}`;

  const advisoryBlock =
    v.advisories.length === 0
      ? ''
      : `<div class="todo" style="margin-top:10px"><b>提示项与建议（不计入不符合）：</b><ol>${v.advisories
          .map((a) => `<li><b>${esc(a.title)}（${esc(a.ref)}）</b>：${esc(a.finding)}建议：${esc(a.advice)}</li>`)
          .join('')}</ol></div>`;

  const ncSection =
    v.nonconformities.length === 0
      ? `<div class="sec"><span class="no">三</span><h2>不符合项与整改</h2><span class="en">NONCONFORMITIES</span></div>
<div class="ok-box">本次已评估的条款未发现不符合项。${v.todos.length > 0 ? '仍有待完成事项（见第一节），补齐后再出具完整结论。' : ''}</div>${advisoryBlock}`
      : `<div class="sec pb"><span class="no">三</span><h2>不符合项与整改</h2><span class="en">NONCONFORMITIES &amp; REMEDIATION</span></div>
<p class="basis">每个不符合项列出差距、证据、整改措施与验收方式。整改措施取自 GB/T 45654—2025 对服务提供者的要求条款。</p>
${v.nonconformities
  .map(
    (n, idx) => `<div class="nc">
  <div class="hd"><span class="no">不符合项 ${idx + 1}</span><b>${esc(n.title)}</b><span class="ref">${esc(n.ref)}</span></div>
  <div class="gap">${esc(n.gap)}</div>
  ${
    n.distribution.length > 0
      ? `<div class="k">问题集中在哪里（附录 A 小项：不合格题数 / 该项有效判定 · 占全部不合格的比例）</div>
  <table class="bars">${n.distribution
    .map(
      (d) => `<tr><td style="width:46%"><b>${esc(d.code)}</b> ${esc(d.name)}</td><td><div class="track"><div class="fill" style="width:${Math.min(100, Math.round((d.failed / Math.max(1, d.tested)) * 100))}%"></div></div></td><td class="num" style="width:20%;text-align:right;white-space:nowrap">${d.failed}/${d.tested} · ${d.share.toFixed(1)}%</td></tr>`,
    )
    .join('')}</table>`
      : ''
  }
  ${
    n.examples.length > 0
      ? `<div class="k">典型问题（题目与回答摘录）</div>${n.examples
          .map(
            (e) => `<div class="ex"><div class="q">${esc(e.code)} ${esc(e.name)}｜题目：${esc(e.question)}</div><div class="a">回答摘录：${esc(e.answer)}</div><div class="r">判定理由：${esc(e.reason)}</div></div>`,
          )
          .join('')}`
      : ''
  }
  ${
    n.majors.length > 0
      ? `<div class="k">按风险大类的整改重点</div>
  <table class="t"><colgroup><col style="width:22%"><col style="width:12%"><col style="width:22%"><col></colgroup><thead><tr><th>风险大类</th><th class="c">不合格</th><th>主要小项</th><th>整改重点</th></tr></thead><tbody>${n.majors
    .map((m) => `<tr><td><b>${esc(m.code)}</b> ${esc(m.name)}</td><td class="c num">${m.failed}</td><td>${esc(m.items)}</td><td>${esc(m.focus)}</td></tr>`)
    .join('')}</tbody></table>`
      : ''
  }
  <div class="k">整改措施（依据 GB/T 45654—2025）</div>
  <ul class="acts">${n.actions.map((a) => `<li><span class="ar">${esc(a.ref)}</span><span>${esc(a.text)}</span></li>`).join('')}</ul>
  <div class="accept"><b>验收方式：</b>${esc(n.acceptance)}</div>
</div>`,
  )
  .join('')}${advisoryBlock}`;

  const methodSection = `
<div class="sec pb"><span class="no">四</span><h2>评估方法与过程</h2><span class="en">METHOD</span></div>
<div class="sub-h">依据与范围</div>
${v.basisParagraphs.map((p) => `<p>${esc(p)}</p>`).join('')}
<div class="sub-h">题库与抽样</div>
<table class="t"><colgroup><col style="width:16%"><col style="width:9%"><col style="width:12%"><col><col style="width:12%"><col style="width:11%"></colgroup>
<thead><tr><th>题库</th><th class="c">规模</th><th class="c">版本</th><th>覆盖情况</th><th class="c">附录 B 下限</th><th class="c">本次抽样</th></tr></thead><tbody>
${v.banks.map((b) => `<tr><td>${esc(b.name)}</td><td class="c num">${esc(b.size)}</td><td class="c num">${esc(b.version)}</td><td>${esc(b.coverage)}</td><td class="c num">${esc(b.min)}</td><td class="c num"><b>${esc(b.selected)}</b></td></tr>`).join('')}
</tbody></table>
<p class="basis">${esc(v.samplingNote)}</p>
<div class="sub-h">四种方法的结果</div>
<table class="t"><colgroup><col style="width:33%"><col style="width:27%"><col style="width:22%"><col style="width:18%"></colgroup>
<thead><tr><th>方法与依据</th><th>本次结果</th><th>要求</th><th class="c">结论</th></tr></thead><tbody>
${v.methods
  .map(
    (m) => `<tr><td><span class="mname">${esc(m.label)}</span><span class="sub">${esc(m.basis)}</span></td><td><b class="big num">${esc(m.result)}</b><span class="sub">${esc(m.resultSub)}</span></td><td class="num">${esc(m.requirement)}<span class="sub">${esc(m.requirementSub)}</span></td><td class="c">${chip(m.chip)}</td></tr>`,
  )
  .join('')}
</tbody></table>
<p class="basis">${esc(v.methodNote)}</p>`;

  const annexSection = `
<div class="sec pb"><span class="no">五</span><h2>附录 A 31 项逐项结果</h2><span class="en">ANNEX A RISKS</span></div>
<div class="legend">数字为「不合格题数 / 有效判定题数」<i style="background:${TONE.nonconform.fg}"></i>发现风险<i style="background:${TONE.conform.fg}"></i>未发现风险<i style="background:${TONE.pending.fg}"></i>样本不足或未测</div>
${v.annex
  .map(
    (g) => `<div class="amajor"><div class="amh"><b>${esc(g.code)}</b> ${esc(g.name)}</div><div class="agrid">${g.items
      .map((i) => {
        const t = i.status === 'risk' ? TONE.nonconform : i.status === 'clean' ? TONE.conform : TONE.pending;
        return `<div class="acell" style="border-color:${t.fg}33;background:${t.bg}"><div class="acode" style="color:${t.fg}">${esc(i.code)}</div><div class="aname">${esc(i.name)}</div><div class="arate num" style="color:${t.fg}">${i.tested > 0 ? `${i.failed}/${i.tested}` : '未测'}</div></div>`;
      })
      .join('')}</div></div>`,
  )
  .join('')}`;

  const measureSection = `
<div class="sec pb"><span class="no">六</span><h2>安全措施核验</h2><span class="en">SECURITY MEASURES</span></div>
<table class="t"><colgroup><col style="width:28%"><col style="width:14%"><col><col style="width:16%"></colgroup>
<thead><tr><th>措施与依据条款</th><th class="c">结论</th><th>依据与说明</th><th>确认人</th></tr></thead><tbody>
${v.measures.map((m) => `<tr><td><b>${esc(m.title)}</b><span class="sub">${esc(m.ref)}</span></td><td class="c">${chip(m.chip)}</td><td>${esc(m.basis)}</td><td>${esc(m.who)}</td></tr>`).join('')}
</tbody></table>
${v.outOfScopeNote ? `<p class="basis" style="margin-top:6px">${esc(v.outOfScopeNote)}</p>` : ''}`;

  const sign = `
<div class="sec"><span class="no">七</span><h2>签字</h2><span class="en">SIGNATURES</span></div>
<table class="t sign"><colgroup><col style="width:30%"><col><col style="width:24%"></colgroup>
<thead><tr><th>职务</th><th>签字</th><th>日期</th></tr></thead><tbody>
<tr><td>法定代表人</td><td></td><td></td></tr><tr><td>安全评估负责人</td><td></td><td></td></tr><tr><td>合法性评估负责人</td><td></td><td></td></tr></tbody></table>`;

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${style(reportNo)}</style></head><body>
${cover}${summary}${clauseTable}${ncSection}${methodSection}${annexSection}${measureSection}${sign}
</body></html>`;
}
