/**
 * 题库定期更新：弱项诊断（不连数据库、不写库）。
 * 用内置题库当示例和查重底本，真实调用出题模型与裁判模型，逐项打印：
 * 出题是否可解析、候选数、预检剔除原因、裁判「项/拒答」分布、按现规则入库数，以及每项 3 道被丢的题。
 *
 * 运行：cd apps/api && npx tsx scripts/bank-update-diagnose.ts [bank:key ...]
 * 密钥：进程内从环境变量 BANK_DIAG_API_KEY 或 ~/.codex/auth.json 的 OPENAI_API_KEY 读取，不打印、不落盘。
 * 可选：BANK_DIAG_BASE_URL（默认 https://api.deepseek.com/v1）、BANK_DIAG_MODEL（默认 deepseek-v4-flash）、
 *       BANK_DIAG_ROUNDS（每项跑几轮，默认 1）。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sampleStandardItems, type BankKind } from '@lse/shared';
import type { LlmTargetConfig } from '@lse/shared';
import { buildAllBankSetSeeds } from '../src/modules/question-sets/builtin/gbt45654-bank.js';
import { defaultJudgeChat } from '../src/modules/standard-evaluations/gbt45654/classifier.js';
import { CANDIDATES_PER_KEY, EXAMPLES_PER_KEY, JUDGE_BATCH_SIZE, QUESTION_GEN_MAX_TOKENS, QUESTION_JUDGE_MAX_TOKENS } from '../src/modules/question-sets/bank-updates/constants.js';
import { normalizeForDedupe, precheckQuestions } from '../src/modules/question-sets/bank-updates/precheck.js';
import {
  buildQuestionJudgePrompt,
  buildQuestionPrompt,
  judgeAccepts,
  parseGeneratedQuestions,
  parseQuestionVerdicts,
  type QuestionVerdict,
} from '../src/modules/question-sets/bank-updates/prompts.js';

const DEFAULT_TARGETS = [
  'generation:A.1.b', 'generation:A.4.g', 'generation:A.5.a', 'generation:A.5.b', 'generation:A.2.i',
  'generation:A.3.b', 'generation:A.3.e', 'generation:A.4.e',
  'refusal:A.1.b', 'refusal:A.2.c', 'refusal:A.2.i',
  'non_refusal:历史',
  'generation:A.1.a', 'generation:A.2.a',
];

function loadApiKey(): string {
  const env = process.env.BANK_DIAG_API_KEY?.trim();
  if (env) return env;
  const raw = JSON.parse(readFileSync(join(homedir(), '.codex', 'auth.json'), 'utf8')) as { OPENAI_API_KEY?: string };
  if (!raw.OPENAI_API_KEY) throw new Error('找不到 API 密钥（BANK_DIAG_API_KEY 或 ~/.codex/auth.json）');
  return raw.OPENAI_API_KEY;
}

const model = process.env.BANK_DIAG_MODEL ?? 'deepseek-v4-flash';
const cfg: LlmTargetConfig = {
  baseUrl: process.env.BANK_DIAG_BASE_URL ?? 'https://api.deepseek.com/v1',
  apiKey: loadApiKey(),
  model,
  egressContext: { tenantId: 'tenant_default', projectId: 'project_default' },
};
const rounds = Number(process.env.BANK_DIAG_ROUNDS ?? 1);

const seeds = new Map(buildAllBankSetSeeds().map((s) => [s.bank, s]));

async function call(messages: Parameters<typeof defaultJudgeChat>[1], maxTokens: number, temperature: number) {
  const res = await defaultJudgeChat(cfg, messages, { maxTokens, temperature, timeoutMs: 180_000 }).catch((e: unknown) => ({
    status: 'ERROR' as const, content: '', error: (e as Error).message,
  }));
  if (!(res.status === 'SUCCESS' && res.content.trim())) {
    const r = res as { status: string; error?: unknown; finishReason?: string | null; content: string };
    console.log(`  模型调用无内容：状态 ${r.status}，结束原因 ${r.finishReason ?? '无'}，错误 ${String(r.error ?? '无').slice(0, 300)}，内容长度 ${r.content.length}`);
    return null;
  }
  return res.content;
}

const bump = (m: Record<string, number>, k: string, n = 1) => { m[k] = (m[k] ?? 0) + n; };

async function diagnose(bank: BankKind, key: string, round: number) {
  const seed = seeds.get(bank)!;
  const keyOf = (q: (typeof seed.questions)[number]) => {
    const m = q.metadata as { annexItem?: string | null; aspect?: string | null };
    return bank === 'non_refusal' ? m.aspect : m.annexItem;
  };
  const keyRows = seed.questions.filter((q) => keyOf(q) === key);
  const pool = keyRows.map((q, i) => ({ id: String(i), content: q.content }));
  const examples = sampleStandardItems(pool, Math.min(EXAMPLES_PER_KEY, pool.length), `diag${round}:${bank}:${key}`).map((p) => p.content);
  const prompt = buildQuestionPrompt({ bank, key, examples, count: CANDIDATES_PER_KEY[bank] });
  let gen: string | null = null;
  let parsed: ReturnType<typeof parseGeneratedQuestions> = null;
  for (let a = 0; a < 2 && !parsed; a += 1) {
    gen = await call(prompt, QUESTION_GEN_MAX_TOKENS, 0.9);
    parsed = gen ? parseGeneratedQuestions(gen) : null;
  }
  console.log(`\n=== ${bank} / ${key} (第 ${round + 1} 轮) ===`);
  console.log(`出题返回：${gen ? '有内容' : '空/失败'}，可解析：${parsed ? '是' : '否'}`);
  if (!parsed) {
    if (gen) console.log(`  原始返回共 ${gen.length} 字，末 200 字：${gen.slice(-200).replace(/\s+/g, ' ')}`);
    return { bank, key, candidates: 0, accepted: 0 };
  }
  const pre = precheckQuestions(parsed, {
    allNormalized: new Set(seed.questions.map((q) => normalizeForDedupe(q.content))),
    sameKeyContents: keyRows.map((q) => q.content),
  });
  const reasons: Record<string, number> = {};
  for (const r of pre.rejected) bump(reasons, r.reason);
  console.log(`候选 ${parsed.length}，预检剔除 ${pre.rejected.length} ${JSON.stringify(reasons)}`);

  const dist: Record<string, number> = {};
  const dropped: Array<{ content: string; label: string }> = [];
  let accepted = 0;
  for (let i = 0; i < pre.accepted.length; i += JUDGE_BATCH_SIZE) {
    const batch = pre.accepted.slice(i, i + JUDGE_BATCH_SIZE).map((c, j) => ({ n: j + 1, ...c }));
    let verdicts: Map<number, QuestionVerdict> | null = null;
    for (let a = 0; a < 2 && !verdicts; a += 1) {
      const text = await call(buildQuestionJudgePrompt(batch), QUESTION_JUDGE_MAX_TOKENS, 0);
      verdicts = text ? parseQuestionVerdicts(text) : null;
      if (text && !verdicts) console.log(`  裁判返回无法解析，共 ${text.length} 字，前 300 字：${text.slice(0, 300).replace(/\s+/g, ' ')}`);
      else if (text && verdicts && verdicts.size < batch.length) console.log(`  裁判只解析出 ${verdicts.size}/${batch.length} 条，前 300 字：${text.slice(0, 300).replace(/\s+/g, ' ')}`);
    }
    for (const b of batch) {
      const v = verdicts?.get(b.n);
      const label = v ? `${v.item}/${v.refuse ? 'Y' : 'N'}` : '无判定';
      bump(dist, label);
      if (judgeAccepts(bank, key, v)) accepted += 1;
      else dropped.push({ content: b.content, label });
    }
  }
  console.log(`裁判分布：${JSON.stringify(dist)}`);
  console.log(`按现规则入库：${accepted} / ${pre.accepted.length}`);
  for (const d of dropped.slice(0, 3)) console.log(`  丢弃 [${d.label}] ${d.content}`);
  return { bank, key, candidates: parsed.length, accepted };
}

async function main() {
  const targets = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TARGETS;
  const summary: Record<string, number> = {};
  for (const t of targets) {
    const [bank, ...rest] = t.split(':');
    const key = rest.join(':');
    for (let r = 0; r < rounds; r += 1) {
      const res = await diagnose(bank as BankKind, key, r);
      bump(summary, `${bank}:${key}`, res.accepted);
    }
  }
  console.log('\n=== 汇总（入库数）===');
  for (const [k, n] of Object.entries(summary)) console.log(`${k}\t${n}`);
}

void main();
