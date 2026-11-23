/**
 * 开发期一次性脚本（非 *.test.ts，不进生产镜像运行路径）：
 *   从生产 DB 只读抽样 → 四类分层 → 预填候选真值 → 写候选 JSONL 供人工纠错。
 *
 * 设计要点：
 *   - 只读 evalResult.findMany（= SELECT），绝不写生产 DB。
 *   - eval_result:FAIL / eval_result:PASS / finding:CONFIRMED / finding:FALSE_POSITIVE
 *     这些已有先验标签的项【不调 AI】（避免用同一个 judge 复核它自己的标签 = 循环论证，
 *     会人为抬高 baseline 一致率）。真值由任务 6 的人工确认。
 *   - AI 预填只用于没有任何可用先验标签的项：finding:NEEDS_REVIEW（难例）+ ambiguous（兜底）。
 *     且只对【实际被选入桶】的项调 judge()，调用次数受配额上界严格约束（正常约 10–40 次）。
 *
 * 运行（本机/开发，连只读 DB）：
 *   # 真实模型预填：需 LLM_JUDGE_BASE_URL / LLM_JUDGE_API_KEY / LLM_JUDGE_MODEL 三者齐全（judgeTarget()≠null）。
 *   # 三者未配齐时自动降级为「规则回退」，AI 预填项 source 记为 ai_prefill:rule_fallback。
 *   # 注意：本脚本【不受 LSE_TEST 影响】——LSE_TEST 门控在 catalog.ts 的 externalsEnabled，
 *   #       本脚本绕过 catalog 直接 createLlmJudgeEngine()，故 AI 预填仅由上述三个 env 是否齐全决定。
 *   cd apps/api && node --import tsx test/judge-accuracy/export-candidates.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { JudgeInput, LlmTargetConfig, QuestionType, Severity } from '@lse/shared';
import { prisma } from '../../src/db.js';
import { config } from '../../src/config.js';
import { createLlmJudgeEngine } from '../../src/modules/engines/llm-judge.js';
import type { GoldCategory, GoldSeverity, GoldVerdict } from './gold-set.js';

// ============================= 抽样口径（用户已批准） =============================
// 规模 180 条，FAIL 113 / PASS 67，四类分层 + 每类显式 FAIL/PASS 配额。
const QUOTAS: Record<GoldCategory, { fail: number; pass: number }> = {
  PROMPT_INJECTION: { fail: 45, pass: 25 }, // = 70
  SHOULD_REFUSE: { fail: 32, pass: 16 }, //    = 48
  COMPLIANCE: { fail: 27, pass: 10 }, //       = 37
  GENERAL: { fail: 9, pass: 16 }, //           = 25
};

const CATEGORIES: readonly GoldCategory[] = [
  'PROMPT_INJECTION',
  'SHOULD_REFUSE',
  'COMPLIANCE',
  'GENERAL',
];

// 信任分层标签（不调 AI 即可判定，依据 findings.reviewStatus 与 finalVerdict）。
type Tier =
  | 'finding:CONFIRMED'
  | 'finding:FALSE_POSITIVE'
  | 'finding:NEEDS_REVIEW'
  | 'eval_result:FAIL'
  | 'eval_result:PASS'
  | 'ambiguous';

// AI 调用硬上界（安全阀）：超过即视为填充逻辑有 bug，停下报告而非疯狂打 API。
const AI_CALL_HARD_CAP = 50;

function judgeTarget(): LlmTargetConfig | null {
  if (!config.LLM_JUDGE_BASE_URL || !config.LLM_JUDGE_API_KEY || !config.LLM_JUDGE_MODEL) {
    return null;
  }
  return {
    baseUrl: config.LLM_JUDGE_BASE_URL,
    apiKey: config.LLM_JUDGE_API_KEY,
    model: config.LLM_JUDGE_MODEL,
  };
}

function normSeverity(s: string | null | undefined): GoldSeverity {
  const up = (s ?? '').toUpperCase();
  if (up === 'INFO' || up === 'LOW' || up === 'MEDIUM' || up === 'HIGH' || up === 'CRITICAL')
    return up;
  return 'MEDIUM';
}

function isGoldCategory(t: string): t is GoldCategory {
  return t === 'PROMPT_INJECTION' || t === 'SHOULD_REFUSE' || t === 'COMPLIANCE' || t === 'GENERAL';
}

interface Candidate {
  id: string;
  category: GoldCategory;
  severity: GoldSeverity;
  prompt: string;
  response: string;
  goldVerdict: GoldVerdict;
  shouldRefuse: boolean;
  source: string;
  note: string;
}

// 一条 eligible 行的内部表示（已分好 tier，保留排序与原始字段）。
interface Row {
  evalResultId: string;
  category: GoldCategory;
  severity: GoldSeverity;
  prompt: string;
  response: string;
  shouldRefuse: boolean;
  tier: Tier;
}

// 对一行依据 findings + finalVerdict 按互斥优先级判定 tier。
function classifyTier(
  reviewStatuses: ReadonlySet<string>,
  finalVerdict: string | null | undefined,
): Tier {
  if (reviewStatuses.has('CONFIRMED')) return 'finding:CONFIRMED';
  if (reviewStatuses.has('FALSE_POSITIVE')) return 'finding:FALSE_POSITIVE';
  if (reviewStatuses.has('NEEDS_REVIEW')) return 'finding:NEEDS_REVIEW';
  if (finalVerdict === 'FAIL') return 'eval_result:FAIL';
  if (finalVerdict === 'PASS') return 'eval_result:PASS';
  return 'ambiguous';
}

async function main(): Promise<void> {
  const target = judgeTarget();
  const aiMode = target ? '真实模型' : '规则回退';
  console.log(
    `[export-candidates] AI 预填模式：${aiMode}（judgeTarget()=${target ? '已配置' : 'null'}）`,
  );

  const engine = createLlmJudgeEngine({ target, enabled: target !== null });

  // 只读 SELECT：拉全量评测记录（含 question + findings），按 id 升序保证可复现。
  const rows = await prisma.evalResult.findMany({
    include: { question: true, findings: true },
    orderBy: { id: 'asc' },
  });
  console.log(`[export-candidates] evalResult 总行数：${rows.length}`);

  // ---- 收集 eligible 行进 per-category × per-tier 列表（保持 id 顺序）----
  type Buckets = Record<Tier, Row[]>;
  const emptyBuckets = (): Buckets => ({
    'finding:CONFIRMED': [],
    'finding:FALSE_POSITIVE': [],
    'finding:NEEDS_REVIEW': [],
    'eval_result:FAIL': [],
    'eval_result:PASS': [],
    ambiguous: [],
  });
  const byCat: Record<GoldCategory, Buckets> = {
    PROMPT_INJECTION: emptyBuckets(),
    SHOULD_REFUSE: emptyBuckets(),
    COMPLIANCE: emptyBuckets(),
    GENERAL: emptyBuckets(),
  };

  let skippedNoQuestion = 0;
  let skippedNoResponse = 0;
  let skippedOtherType = 0;

  for (const r of rows) {
    if (!r.question) {
      skippedNoQuestion++;
      continue;
    }
    const response = (r.response ?? '').trim();
    if (response === '') {
      skippedNoResponse++;
      continue;
    }
    const type = (r.question.type ?? 'GENERAL') as string;
    if (!isGoldCategory(type)) {
      skippedOtherType++;
      continue;
    }
    const reviewStatuses = new Set<string>(r.findings.map((f) => f.reviewStatus));
    const tier = classifyTier(reviewStatuses, r.finalVerdict);
    byCat[type][tier].push({
      evalResultId: r.id,
      category: type,
      severity: normSeverity(r.question.severity),
      prompt: r.question.content,
      response: r.response ?? '',
      shouldRefuse: r.question.shouldRefuse,
      tier,
    });
  }

  console.log(
    `[export-candidates] 跳过：无 question=${skippedNoQuestion} 空 response=${skippedNoResponse} 非四类=${skippedOtherType}`,
  );

  // ---- AI 预填缓存：只对实际被选入桶/试评的 NEEDS_REVIEW + ambiguous 行调一次 judge ----
  // 返回三态：FAIL / PASS / ABSTAIN（弃权：UNKNOWN/ERROR/非 success 或触顶）。
  type AiVerdict = GoldVerdict | 'ABSTAIN';
  let aiCalls = 0;
  let aiCapTripped = false;
  const aiVerdictCache = new Map<string, AiVerdict>(); // evalResultId -> 草稿裁决

  async function aiVerdict(row: Row): Promise<AiVerdict> {
    const cached = aiVerdictCache.get(row.evalResultId);
    if (cached !== undefined) return cached;
    if (aiCalls >= AI_CALL_HARD_CAP) {
      aiCapTripped = true;
      // 触顶后不再发起新调用，剩余一律弃权（既不进 FAIL 也不进 PASS，避免误标）。
      aiVerdictCache.set(row.evalResultId, 'ABSTAIN');
      return 'ABSTAIN';
    }
    aiCalls++;
    const input: JudgeInput = {
      taskId: `candidate:${row.evalResultId}`,
      questionId: row.evalResultId,
      questionType: row.category as QuestionType,
      prompt: row.prompt,
      response: row.response,
      shouldRefuse: row.shouldRefuse,
      severity: row.severity as Severity,
    };
    const result = await engine.judge(input);
    // 与 harness.toPredicted 同口径：success+FAIL→FAIL；success+PASS→PASS；其余→弃权。
    let verdict: AiVerdict;
    if (result.status === 'success' && result.verdict === 'FAIL') verdict = 'FAIL';
    else if (result.status === 'success' && result.verdict === 'PASS') verdict = 'PASS';
    else verdict = 'ABSTAIN';
    aiVerdictCache.set(row.evalResultId, verdict);
    return verdict;
  }

  // ---- 逐类填充 FAIL 桶 / PASS 桶 ----
  interface Filled {
    row: Row;
    goldVerdict: GoldVerdict;
    aiPrefill: boolean; // 是否由 AI 预填（用于 source/note 标注）
  }
  const result: Record<GoldCategory, { fail: Filled[]; pass: Filled[] }> = {
    PROMPT_INJECTION: { fail: [], pass: [] },
    SHOULD_REFUSE: { fail: [], pass: [] },
    COMPLIANCE: { fail: [], pass: [] },
    GENERAL: { fail: [], pass: [] },
  };

  for (const cat of CATEGORIES) {
    const quota = QUOTAS[cat];
    const buckets = byCat[cat];

    // ===== FAIL 桶 =====
    const fail = result[cat].fail;
    // 1) 先纳入难例 NEEDS_REVIEW（最多 reserveNR 条），需 AI 预填，只采信判 FAIL 的。
    const reserveNR = Math.min(Math.ceil(quota.fail * 0.2), buckets['finding:NEEDS_REVIEW'].length);
    // NEEDS_REVIEW 难例的 AI 试评结果分流：判 PASS 的留给 PASS 桶（边界难例同样有价值）。
    const nrPassPool: Row[] = [];
    let nrProbed = 0;
    let nrFail = 0;
    let nrPass = 0;
    let nrAbstain = 0;
    for (const row of buckets['finding:NEEDS_REVIEW']) {
      // reserve 只统计真正进 FAIL 桶的难例；判 PASS/弃权不占名额，故循环继续。
      if (fail.length >= quota.fail || nrFail >= reserveNR) break;
      const v = await aiVerdict(row);
      nrProbed++;
      if (v === 'FAIL') {
        fail.push({ row, goldVerdict: 'FAIL', aiPrefill: true });
        nrFail++;
      } else if (v === 'PASS') {
        nrPassPool.push(row);
        nrPass++;
      } else {
        nrAbstain++; // 弃权：既不进 FAIL 也不进 PASS
      }
    }
    console.log(
      `  [${cat}] NEEDS_REVIEW 试评 ${nrProbed} → FAIL ${nrFail} / PASS ${nrPass} / 弃权 ${nrAbstain}；FAIL桶难例 ${nrFail}/reserve ${reserveNR}`,
    );
    // 2) finding:CONFIRMED（人工背书，不调 AI）。
    for (const row of buckets['finding:CONFIRMED']) {
      if (fail.length >= quota.fail) break;
      fail.push({ row, goldVerdict: 'FAIL', aiPrefill: false });
    }
    // 3) eval_result:FAIL（采信 finalVerdict，不调 AI）。
    for (const row of buckets['eval_result:FAIL']) {
      if (fail.length >= quota.fail) break;
      fail.push({ row, goldVerdict: 'FAIL', aiPrefill: false });
    }
    // 4) ambiguous 兜底（AI 判 FAIL 的才进 FAIL 桶）。
    for (const row of buckets.ambiguous) {
      if (fail.length >= quota.fail) break;
      const v = await aiVerdict(row);
      if (v === 'FAIL') fail.push({ row, goldVerdict: 'FAIL', aiPrefill: true });
    }

    // ===== PASS 桶 =====
    const pass = result[cat].pass;
    // 已被 FAIL 桶选走的 evalResultId 不再复用。
    const usedIds = new Set(fail.map((f) => f.row.evalResultId));
    // 0) NEEDS_REVIEW 中被 AI 判 PASS 的难例优先补充 PASS 桶（边界难例，AI 预填）。
    for (const row of nrPassPool) {
      if (pass.length >= quota.pass) break;
      if (usedIds.has(row.evalResultId)) continue;
      pass.push({ row, goldVerdict: 'PASS', aiPrefill: true });
      usedIds.add(row.evalResultId);
    }
    // 1) finding:FALSE_POSITIVE（人工背书，不调 AI）。
    for (const row of buckets['finding:FALSE_POSITIVE']) {
      if (pass.length >= quota.pass) break;
      if (usedIds.has(row.evalResultId)) continue;
      pass.push({ row, goldVerdict: 'PASS', aiPrefill: false });
    }
    // 2) eval_result:PASS（采信 finalVerdict，不调 AI）。
    for (const row of buckets['eval_result:PASS']) {
      if (pass.length >= quota.pass) break;
      if (usedIds.has(row.evalResultId)) continue;
      pass.push({ row, goldVerdict: 'PASS', aiPrefill: false });
    }
    // 3) ambiguous 兜底（AI 判 PASS 的才进 PASS 桶）。
    for (const row of buckets.ambiguous) {
      if (pass.length >= quota.pass) break;
      if (usedIds.has(row.evalResultId)) continue;
      const v = await aiVerdict(row);
      if (v === 'PASS') pass.push({ row, goldVerdict: 'PASS', aiPrefill: true });
    }

    if (aiCapTripped) break; // 触顶后不再继续填充其余类别，留待人工/重跑。
  }

  // ---- 生成候选行（GoldItem-兼容），逐类编号 FAIL 在前、PASS 在后 ----
  const candidates: Candidate[] = [];
  // source 命中统计（按 tier 维度）。
  const sourceHits: Record<string, number> = {};
  const bump = (k: string) => {
    sourceHits[k] = (sourceHits[k] ?? 0) + 1;
  };

  const aiFallback = target === null; // 规则回退时 AI 预填项 source 用专门后缀。

  for (const cat of CATEGORIES) {
    const ordered = [...result[cat].fail, ...result[cat].pass];
    let seq = 0;
    for (const f of ordered) {
      seq++;
      const seqStr = String(seq).padStart(3, '0');
      const row = f.row;

      let source: string;
      if (f.aiPrefill) {
        source = aiFallback ? 'ai_prefill:rule_fallback' : 'ai_prefill';
      } else {
        source = row.tier; // finding:CONFIRMED / finding:FALSE_POSITIVE / eval_result:FAIL / eval_result:PASS
      }
      bump(source);

      // note：基础提示 + 重点复核标注。
      let note = `evalResult=${row.evalResultId} 待人工确认`;
      if (f.aiPrefill) {
        note += '·AI预填·重点复核';
      } else if (row.tier === 'eval_result:FAIL' || row.tier === 'eval_result:PASS') {
        note += '·judge派生·重点复核';
      }

      candidates.push({
        id: `${cat.toLowerCase()}-${seqStr}`,
        category: cat,
        severity: row.severity,
        prompt: row.prompt,
        response: row.response,
        goldVerdict: f.goldVerdict,
        shouldRefuse: row.shouldRefuse,
        source,
        note,
      });
    }
  }

  // ---- 写候选 JSONL ----
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, '.candidates');
  const outPath = join(outDir, 'judge-gold-set.candidate.jsonl');
  mkdirSync(outDir, { recursive: true });
  const jsonl = candidates.map((c) => JSON.stringify(c)).join('\n') + '\n';
  writeFileSync(outPath, jsonl, 'utf8');

  // ============================= 摘要 =============================
  console.log('\n========== 候选导出摘要 ==========');
  for (const cat of CATEGORIES) {
    const q = QUOTAS[cat];
    const f = result[cat].fail.length;
    const p = result[cat].pass.length;
    const fShort = f < q.fail ? `（短缺 ${q.fail - f}）` : '';
    const pShort = p < q.pass ? `（短缺 ${q.pass - p}）` : '';
    console.log(`  ${cat.padEnd(16)} FAIL ${f}/${q.fail}${fShort}  PASS ${p}/${q.pass}${pShort}`);
  }
  console.log('  --- 各 source tier 命中 ---');
  for (const [k, v] of Object.entries(sourceHits).sort()) {
    console.log(`    ${k.padEnd(26)} ${v}`);
  }
  const totalFail = CATEGORIES.reduce((s, c) => s + result[c].fail.length, 0);
  const totalPass = CATEGORIES.reduce((s, c) => s + result[c].pass.length, 0);
  console.log(`  --- 合计 ---`);
  console.log(
    `    总条数 ${candidates.length}（FAIL ${totalFail} / PASS ${totalPass}）目标 180（FAIL 113 / PASS 67）`,
  );
  console.log(
    `    AI 调用次数 ${aiCalls}（模式：${aiMode}）` +
      (aiCapTripped ? `  ⚠️ 已触顶 ${AI_CALL_HARD_CAP}，填充提前终止` : ''),
  );
  console.log(`    输出路径 ${outPath}`);
  console.log('  下一步：人工抽查/纠正后另存为 test/fixtures/judge-gold-set.jsonl');
  console.log('==================================\n');

  if (aiCapTripped) {
    console.error(
      `[export-candidates] AI 调用触顶 ${AI_CALL_HARD_CAP}，疑似填充逻辑异常或 ambiguous 兜底被大量动用，请人工核查后再重跑。`,
    );
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('[export-candidates] 失败：', err);
  await prisma.$disconnect();
  process.exit(1);
});
