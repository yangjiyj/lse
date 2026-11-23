/**
 * 开发期脚本（非 *.test.ts，不进生产镜像运行路径）：
 *   用真实全局 JUDGE 在定稿 gold set 上跑现有单发裁判，产出 baseline 快照。
 * 运行（本机/开发，需联网调模型；勿带 LSE_TEST=1）：
 *   cd apps/api && node --import tsx test/judge-accuracy/run-baseline.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { LlmTargetConfig } from '@lse/shared';
import { config } from '../../src/config.js';
import { createLlmJudgeEngine } from '../../src/modules/engines/llm-judge.js';
import { loadGoldSet } from './gold-set.js';
import { runHarness } from './harness.js';
import type { AccuracyMetrics, CategoryMetrics } from './metrics.js';

const STAMP = '2026-06-16';

function judgeTarget(): LlmTargetConfig {
  // 注意：刻意不检查 LLM_JUDGE_ENABLED——baseline 脚本必须走真实模型产出对照基线，
  // 不受该 feature flag 约束（flag 只管生产服务里的裁判开关，与离线 baseline 无关）。
  if (!config.LLM_JUDGE_BASE_URL || !config.LLM_JUDGE_API_KEY || !config.LLM_JUDGE_MODEL) {
    throw new Error(
      '未配置 LLM_JUDGE_BASE_URL / LLM_JUDGE_API_KEY / LLM_JUDGE_MODEL，无法跑真实裁判 baseline',
    );
  }
  return {
    baseUrl: config.LLM_JUDGE_BASE_URL,
    apiKey: config.LLM_JUDGE_API_KEY,
    model: config.LLM_JUDGE_MODEL,
  };
}

function pct(x: number | null): string {
  return x === null ? 'N/A' : `${(x * 100).toFixed(1)}%`;
}

function row(name: string, m: CategoryMetrics): string {
  return `| ${name} | ${m.total} | ${m.decided} | ${m.abstained} | ${pct(m.agreement)} | ${m.fn}/${m.goldFail} (${pct(m.fnRate)}) | ${m.fp}/${m.goldPass} (${pct(m.fpRate)}) |`;
}

function toMarkdown(metrics: AccuracyMetrics, total: number): string {
  const lines: string[] = [];
  lines.push(`# 裁判 baseline 快照（${STAMP}）`);
  lines.push('');
  lines.push('- 裁判：现有单发 llm-judge（temperature 0）');
  lines.push(`- 标注集：${total} 条 vendor 内部 gold set`);
  lines.push('- 口径：仅在本标注集上陈述，**不外推**为整体准确率');
  lines.push('');
  lines.push('| 维度 | 总数 | 已判定 | 弃权 | 一致率 | 漏判 FN | 误报 FP |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  lines.push(row('总体', metrics.overall));
  for (const cat of Object.keys(metrics.byCategory)) {
    lines.push(row(cat, metrics.byCategory[cat]));
  }
  lines.push('');
  lines.push('> FN（漏判）最危险：gold=FAIL 却判 PASS；SHOULD_REFUSE 行单独关注。');
  return lines.join('\n') + '\n';
}

async function main(): Promise<void> {
  const target = judgeTarget();
  const engine = createLlmJudgeEngine({ target, enabled: true });
  const items = loadGoldSet();
  const { predictions, metrics } = await runHarness(engine, items);

  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, 'baseline');
  mkdirSync(outDir, { recursive: true });

  const json = { stamp: STAMP, total: items.length, metrics, predictions };
  writeFileSync(
    join(outDir, `${STAMP}-baseline.json`),
    JSON.stringify(json, null, 2) + '\n',
    'utf8',
  );
  writeFileSync(join(outDir, `${STAMP}-baseline.md`), toMarkdown(metrics, items.length), 'utf8');

  console.log(toMarkdown(metrics, items.length));
  console.log(`baseline 已写入 ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
