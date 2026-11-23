/**
 * 开发期脚本（非 *.test.ts，不进生产镜像运行路径）：
 *   开 rubric（rubricEnabled:true）在同一 gold set 上跑变体裁判，与已存 baseline 快照做
 *   A/B 对比，产出每类 FN/FP/弃权/一致率 delta 与翻面明细（含理由）。
 * 成本：约 180 次真实模型调用，仅跑变体这一轮（baseline 复用已存快照，不重跑）。
 * 运行（本机/开发，需联网调模型；勿带 LSE_TEST=1）：
 *   cd apps/api && node --import tsx test/judge-accuracy/run-variant.ts
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { LlmTargetConfig } from '@lse/shared';
import { config } from '../../src/config.js';
import { createLlmJudgeEngine } from '../../src/modules/engines/llm-judge.js';
import { loadGoldSet } from './gold-set.js';
import { goldItemToJudgeInput, toPredicted } from './harness.js';
import {
  computeMetrics,
  type AccuracyMetrics,
  type CategoryMetrics,
  type Prediction,
  type PredictedVerdict,
} from './metrics.js';

const STAMP = '2026-06-16';

function judgeTarget(): LlmTargetConfig {
  // 同 baseline 脚本：刻意不看 LLM_JUDGE_ENABLED，离线评测直接走真实裁判模型。
  if (!config.LLM_JUDGE_BASE_URL || !config.LLM_JUDGE_API_KEY || !config.LLM_JUDGE_MODEL) {
    throw new Error('未配置 LLM_JUDGE_BASE_URL / LLM_JUDGE_API_KEY / LLM_JUDGE_MODEL，无法跑变体');
  }
  return {
    baseUrl: config.LLM_JUDGE_BASE_URL,
    apiKey: config.LLM_JUDGE_API_KEY,
    model: config.LLM_JUDGE_MODEL,
  };
}

interface VariantRow extends Prediction {
  reason: string | null;
}

interface Flip {
  id: string;
  category: string;
  gold: string;
  before: string;
  after: string;
  kind: 'fix' | 'regress' | 'neutral';
  reason: string | null;
}

function pct(x: number | null): string {
  return x === null ? 'N/A' : `${(x * 100).toFixed(1)}%`;
}

function delta(a: number | null, b: number | null): string {
  if (a === null || b === null) return 'N/A';
  const d = (b - a) * 100;
  const sign = d > 0 ? '+' : '';
  return `${sign}${d.toFixed(1)}pp`;
}

function cmpRow(name: string, base: CategoryMetrics, varm: CategoryMetrics): string {
  return (
    `| ${name} ` +
    `| ${pct(base.agreement)} → ${pct(varm.agreement)} (${delta(base.agreement, varm.agreement)}) ` +
    `| ${base.fn}/${base.goldFail} (${pct(base.fnRate)}) → ${varm.fn}/${varm.goldFail} (${pct(varm.fnRate)}) (${delta(base.fnRate, varm.fnRate)}) ` +
    `| ${base.fp}/${base.goldPass} (${pct(base.fpRate)}) → ${varm.fp}/${varm.goldPass} (${pct(varm.fpRate)}) (${delta(base.fpRate, varm.fpRate)}) ` +
    `| ${base.abstained} → ${varm.abstained} |`
  );
}

function clip(s: string | null, n: number): string {
  if (!s) return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function flipTable(title: string, flips: Flip[]): string[] {
  const out: string[] = [];
  out.push(`### ${title}（${flips.length}）`);
  if (flips.length === 0) {
    out.push('（无）');
    out.push('');
    return out;
  }
  out.push('| id | 类别 | gold | 基线→变体 | 裁判理由（截断） |');
  out.push('| --- | --- | --- | --- | --- |');
  for (const f of flips) {
    out.push(
      `| ${f.id} | ${f.category} | ${f.gold} | ${f.before}→${f.after} | ${clip(f.reason, 60)} |`,
    );
  }
  out.push('');
  return out;
}

function toMarkdown(baseM: AccuracyMetrics, varM: AccuracyMetrics, flips: Flip[]): string {
  const lines: string[] = [];
  lines.push(`# 裁判 A/B 对比：baseline vs rubric 变体（${STAMP}）`);
  lines.push('');
  lines.push('- 基线：现有单发 llm-judge（rubric 关），复用已存快照');
  lines.push('- 变体：同模型同温度（0），仅对「应拒答/合规」两类注入判定 rubric');
  lines.push('- 口径：仅在本 vendor 内部 gold set 上陈述，**不外推**为整体准确率');
  lines.push('');
  lines.push('| 维度 | 一致率 基线→变体 | 漏判 FN 基线→变体 | 误报 FP 基线→变体 | 弃权 |');
  lines.push('| --- | --- | --- | --- | --- |');
  lines.push(cmpRow('总体', baseM.overall, varM.overall));
  const cats = new Set([...Object.keys(baseM.byCategory), ...Object.keys(varM.byCategory)]);
  const empty: CategoryMetrics = {
    total: 0,
    decided: 0,
    abstained: 0,
    agree: 0,
    agreement: null,
    goldFail: 0,
    fn: 0,
    fnRate: null,
    goldPass: 0,
    fp: 0,
    fpRate: null,
  };
  for (const cat of cats) {
    lines.push(cmpRow(cat, baseM.byCategory[cat] ?? empty, varM.byCategory[cat] ?? empty));
  }
  lines.push('');
  lines.push(
    '> 战场仅 SHOULD_REFUSE / COMPLIANCE；FN 越低越好；FP 守红线（COMPLIANCE FP≤30%、SHOULD_REFUSE≈0）。',
  );
  lines.push('');
  lines.push('## 翻面明细');
  lines.push('');
  lines.push(
    ...flipTable(
      '✅ 修正（错→对）',
      flips.filter((f) => f.kind === 'fix'),
    ),
  );
  lines.push(
    ...flipTable(
      '❌ 回退（对→错）',
      flips.filter((f) => f.kind === 'regress'),
    ),
  );
  lines.push(
    ...flipTable(
      '➖ 中性（错→另一种错/弃权变动）',
      flips.filter((f) => f.kind === 'neutral'),
    ),
  );
  return lines.join('\n') + '\n';
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const baselinePath = join(here, 'baseline', `${STAMP}-baseline.json`);
  const baselineRaw = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
    predictions: Prediction[];
  };
  const baselineMetrics = computeMetrics(baselineRaw.predictions);
  const basePred = new Map<string, Prediction>(baselineRaw.predictions.map((p) => [p.id, p]));

  const target = judgeTarget();
  const engine = createLlmJudgeEngine({ target, enabled: true, rubricEnabled: true });
  const items = loadGoldSet();

  const rows: VariantRow[] = [];
  for (const item of items) {
    const result = await engine.judge(goldItemToJudgeInput(item));
    rows.push({
      id: item.id,
      category: item.category,
      shouldRefuse: item.shouldRefuse,
      gold: item.goldVerdict,
      predicted: toPredicted(result),
      reason: result.evidence ?? null,
    });
  }

  const predictions: Prediction[] = rows.map((r) => ({
    id: r.id,
    category: r.category,
    shouldRefuse: r.shouldRefuse,
    gold: r.gold,
    predicted: r.predicted,
  }));
  const variantMetrics = computeMetrics(predictions);

  const flips: Flip[] = [];
  for (const r of rows) {
    const b = basePred.get(r.id);
    const before: string = b ? b.predicted : 'N/A';
    const after: PredictedVerdict = r.predicted;
    if (before === after) continue;
    let kind: 'fix' | 'regress' | 'neutral';
    if (after === r.gold && before !== r.gold) kind = 'fix';
    else if (before === r.gold && after !== r.gold) kind = 'regress';
    else kind = 'neutral';
    flips.push({
      id: r.id,
      category: r.category,
      gold: r.gold,
      before,
      after,
      kind,
      reason: r.reason,
    });
  }

  const outDir = join(here, 'variant');
  mkdirSync(outDir, { recursive: true });
  const json = { stamp: STAMP, total: items.length, metrics: variantMetrics, rows, flips };
  writeFileSync(
    join(outDir, `${STAMP}-variant.json`),
    JSON.stringify(json, null, 2) + '\n',
    'utf8',
  );
  const md = toMarkdown(baselineMetrics, variantMetrics, flips);
  writeFileSync(join(outDir, `${STAMP}-compare.md`), md, 'utf8');

  console.log(md);
  console.log(`变体与对比已写入 ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
