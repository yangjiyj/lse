import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import {
  DEFAULT_PLATFORM_TITLE_TEXT,
  PRODUCT_NAME,
  PRODUCT_NAME_EN,
  PRODUCT_FULL_NAME,
} from '../src/lib/product-name.js';
import { DEFAULT_PLATFORM_TITLE, DEFAULT_TENANT_SETTINGS } from '../src/lib/tenant-branding.js';
import { applyHtmlWatermark, applyWorkbookWatermark } from '../src/lib/data-security.js';
import type { DownloadWatermark } from '../src/lib/data-security.js';
import { buildReportHtmlModel } from '../src/modules/reports/html/model.js';
import { renderReportHtmlString } from '../src/modules/reports/html/render.js';
import { buildWrongAnswerWorkbook } from '../src/modules/reports/excel.js';
import type { BuiltReport } from '../src/modules/reports/report-builder.js';

// 产品名单一来源：运行时代码不得再写死产品名字面量，改名只改 product-name.ts。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LITERALS = ['鉴盾', '大模型安全评估平台'];

function minimalReport(): BuiltReport {
  return {
    title: '大模型安全评估报告',
    format: 'markdown',
    content: '# 大模型安全评估报告',
    passRate: 1,
    totalQuestions: 1,
    riskDistribution: { bySeverity: {}, byRiskCategory: {}, byRiskDomain: {} },
    summary: {
      totalQuestions: 1,
      processedQuestions: 1,
      passedCount: 1,
      failedCount: 0,
      errorCount: 0,
      wrongAnswerCount: 0,
      findingCount: 0,
      evidenceFindingCount: 0,
      verdictDistribution: { PASS: 1 },
      severityDistribution: {},
      charts: {
        severity: [],
        verdict: [{ key: 'PASS', label: '通过', value: 1 }],
        riskCategory: [],
        riskDomain: [],
        engineStatus: [],
        engineRuns: [],
        passRatePercent: 100,
      },
    },
  } as unknown as BuiltReport;
}

test('常量值：品牌名、全称、英文副标与默认标题', () => {
  assert.equal(PRODUCT_NAME, '鉴盾');
  assert.equal(PRODUCT_FULL_NAME, '大模型安全评估平台');
  assert.equal(PRODUCT_NAME_EN, 'AI Safety Assessment');
  assert.equal(DEFAULT_PLATFORM_TITLE_TEXT, '鉴盾 · 大模型安全评估平台');
});

test('租户默认标题来自 DEFAULT_PLATFORM_TITLE_TEXT', () => {
  assert.equal(DEFAULT_PLATFORM_TITLE, DEFAULT_PLATFORM_TITLE_TEXT);
  assert.equal(DEFAULT_TENANT_SETTINGS.platformTitle, DEFAULT_PLATFORM_TITLE_TEXT);
});

test('报告 HTML 封面与页脚使用默认标题「鉴盾 · 大模型安全评估平台」', () => {
  const html = renderReportHtmlString(buildReportHtmlModel(minimalReport(), { reportId: 'X-1' }));
  assert.ok(
    html.includes(`<div class="cover-kicker">${DEFAULT_PLATFORM_TITLE_TEXT}</div>`),
    '封面 kicker',
  );
  assert.ok(html.includes(`content:"${DEFAULT_PLATFORM_TITLE_TEXT}"`), '页脚中间文字');
});

test('下载水印页眉：租户标题优先，替换默认页脚', () => {
  const html = renderReportHtmlString(buildReportHtmlModel(minimalReport(), { reportId: 'X-1' }));
  const wm: DownloadWatermark = {
    text: '租户标题 张三 2026-01-01 00:00:00',
    platformTitle: '租户标题',
    downloader: '张三',
    downloadedAt: '2026-01-01 00:00:00',
  };
  const out = applyHtmlWatermark(html, wm);
  assert.ok(out.includes('content:"租户标题 张三 2026-01-01 00:00:00"'), '页脚应换成水印文本');
  assert.ok(
    !out.includes(`text-align:center; content:"${DEFAULT_PLATFORM_TITLE_TEXT}";`),
    '默认页脚应被替换',
  );
});

test('Excel：创建者为 PRODUCT_NAME，下载水印页眉用租户标题', () => {
  const wb = buildWrongAnswerWorkbook('t', []);
  assert.equal(wb.creator, PRODUCT_NAME);
  const wm: DownloadWatermark = {
    text: `${PRODUCT_NAME} 张三 2026-01-01 00:00:00`,
    platformTitle: PRODUCT_NAME,
    downloader: '张三',
    downloadedAt: '2026-01-01 00:00:00',
  };
  applyWorkbookWatermark(wb as ExcelJS.Workbook, wm);
  for (const ws of wb.worksheets) {
    assert.ok(String(ws.headerFooter.oddHeader).includes(PRODUCT_NAME));
  }
});

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|js|jsx|html|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('源码扫描：api/src 与 web/src 运行时代码不得写死产品名字面量', () => {
  const roots = [path.resolve(HERE, '../src'), path.resolve(HERE, '../../web/src')];
  const offenders: string[] = [];
  for (const root of roots) {
    for (const f of walk(root)) {
      if (/\.(test|spec)\.[tj]sx?$/.test(f)) continue;
      if (f.endsWith(`${path.sep}lib${path.sep}product-name.ts`)) continue;
      if (LITERALS.some((l) => fs.readFileSync(f, 'utf8').includes(l)))
        offenders.push(path.relative(HERE, f));
    }
  }
  assert.deepEqual(offenders, [], `请改为引用 lib/product-name：${offenders.join(', ')}`);
});
