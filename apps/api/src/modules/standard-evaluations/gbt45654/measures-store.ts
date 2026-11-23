import { Prisma, type PrismaClient } from '@prisma/client';
import { getClause } from '@lse/shared';
import {
  invokeEvaluationTarget,
  type EvaluationTargetConfig,
} from '../../eval-targets/invoker.js';
import {
  ABUSE_CLAUSE_ID,
  ABUSE_FOLLOW_UP,
  DEFAULT_ABUSE_INPUTS,
  EXPLICIT_LABEL_CLAUSE_ID,
  MANUAL_FORM_CLAUSES,
  PROBE_CLAUSES,
  abuseMessagesForTurn,
  analyzeAbuseProbe,
  isConfirmedVerdict,
  probeFinding,
  summarizeLabelCheck,
  type AbuseTurn,
  type ManualFormVerdict,
  type ProbeFinding,
} from './measures.js';

/** 第 6 章措施核验的数据库读写。 */

export class MeasureError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

type Invoke = typeof invokeEvaluationTarget;

/**
 * 违规输入处置探测：同一会话里连续发 5 条明显违规的输入，再发 1 条正常问题，
 * 记下每轮回答与 HTTP 状态。结论由 probeFinding 按取证自动得出；重新取证后复核人之前的确认作废，所以这里把 verdict 清空。
 */
export async function runAbuseProbe(
  db: PrismaClient,
  options: {
    runId: string;
    target: EvaluationTargetConfig;
    invoke?: Invoke;
    inputs?: readonly string[];
    followUp?: string;
    timeoutMs?: number;
  },
) {
  const invoke = options.invoke ?? invokeEvaluationTarget;
  const inputs = options.inputs && options.inputs.length > 0 ? options.inputs : DEFAULT_ABUSE_INPUTS;
  const prompts: Array<{ kind: AbuseTurn['kind']; prompt: string }> = [
    ...inputs.map((prompt) => ({ kind: 'abuse' as const, prompt })),
    { kind: 'follow_up', prompt: options.followUp?.trim() || ABUSE_FOLLOW_UP },
  ];
  const turns: AbuseTurn[] = [];
  for (const [index, p] of prompts.entries()) {
    const messages = abuseMessagesForTurn(turns, p.prompt);
    const result = await invoke(options.target, messages, {
      timeoutMs: options.timeoutMs ?? 60_000,
      sessionId: `gbt45654-abuse-${options.runId}`,
    });
    const ok = result.status === 'SUCCESS' && Boolean(result.content?.trim());
    turns.push({
      index: index + 1,
      kind: p.kind,
      prompt: p.prompt,
      response: ok ? result.content : null,
      httpStatus: result.httpStatus ?? null,
      error: ok ? null : (result.error ?? '调用失败'),
    });
  }
  const analysis = analyzeAbuseProbe(turns);
  const evidence = { turns, analysis, takenAt: new Date().toISOString() };
  return db.standardMeasureCheck.upsert({
    where: { runId_clauseId: { runId: options.runId, clauseId: ABUSE_CLAUSE_ID } },
    create: {
      runId: options.runId,
      clauseId: ABUSE_CLAUSE_ID,
      kind: 'PROBE',
      evidence: evidence as unknown as Prisma.InputJsonValue,
    },
    // 重新取证后，之前的确认作废，要复核人重新确认。
    update: {
      evidence: evidence as unknown as Prisma.InputJsonValue,
      verdict: null,
      confirmedById: null,
      confirmedByName: null,
      confirmedAt: null,
    },
  });
}

/** 显式标识检查：统计本次运行里取得回答的样本有多少带「由人工智能生成」一类提示。 */
export async function collectExplicitLabelEvidence(db: PrismaClient, runId: string) {
  const samples = await db.standardSample.findMany({
    where: { standardRunId: runId, selectedResponse: { not: null } },
    select: { id: true, selectedResponse: true },
  });
  if (samples.length === 0) {
    throw new MeasureError('这次运行还没有取得任何模型回答，无法检查标识', 'MEASURE_NO_RESPONSES');
  }
  const summary = summarizeLabelCheck(
    samples.map((s) => ({ sampleId: s.id, text: s.selectedResponse ?? '' })),
  );
  return db.standardMeasureCheck.upsert({
    where: { runId_clauseId: { runId, clauseId: EXPLICIT_LABEL_CLAUSE_ID } },
    create: {
      runId,
      clauseId: EXPLICIT_LABEL_CLAUSE_ID,
      kind: 'PROBE',
      evidence: summary as unknown as Prisma.InputJsonValue,
    },
    update: {
      evidence: summary as unknown as Prisma.InputJsonValue,
      verdict: null,
      confirmedById: null,
      confirmedByName: null,
      confirmedAt: null,
    },
  });
}

/**
 * 自动取证：评估结束和「补跑判定」时调用，不需要人点按钮。
 * - 显式标识：只读已取得的回答，复核人没确认过就重新统计；
 * - 违规输入处置：会向被测对象发 6 条，只在没有取证或上次没取得有效结果时补测（includeAbuse 为 false 时跳过）。
 * 返回本次补了哪几项。
 */
export async function ensureAutoMeasures(
  db: PrismaClient,
  options: { runId: string; target: EvaluationTargetConfig; invoke?: Invoke; includeAbuse?: boolean },
): Promise<string[]> {
  const rows = await db.standardMeasureCheck.findMany({
    where: { runId: options.runId, clauseId: { in: [...PROBE_CLAUSES] } },
  });
  const byClause = new Map(rows.map((r) => [r.clauseId, r]));
  const done: string[] = [];
  if (!byClause.get(EXPLICIT_LABEL_CLAUSE_ID)?.verdict) {
    try {
      await collectExplicitLabelEvidence(db, options.runId);
      done.push(EXPLICIT_LABEL_CLAUSE_ID);
    } catch (error) {
      if (!(error instanceof MeasureError && error.code === 'MEASURE_NO_RESPONSES')) throw error;
    }
  }
  const abuse = byClause.get(ABUSE_CLAUSE_ID);
  if (
    options.includeAbuse !== false &&
    !abuse?.verdict &&
    probeFinding(ABUSE_CLAUSE_ID, abuse?.evidence ?? null).status === 'none'
  ) {
    await runAbuseProbe(db, { runId: options.runId, target: options.target, invoke: options.invoke });
    done.push(ABUSE_CLAUSE_ID);
  }
  return done;
}

export interface ConfirmMeasureInput {
  runId: string;
  clauseId: string;
  verdict: ManualFormVerdict;
  note?: string | null;
  materials?: string | null;
  reviewer: { id: string; name: string };
}

/**
 * 复核人确认或填报。
 * - 平台取证类（违规处置、显式标识）：必须先有取证记录才能确认；
 * - 人工填报类：直接填报，可选符合、不符合、不适用，并写说明与证明材料备注。
 * 说明与证明材料备注都是选填，不加必填项。
 */
export async function confirmMeasure(db: PrismaClient, input: ConfirmMeasureInput) {
  const isProbe = PROBE_CLAUSES.includes(input.clauseId);
  if (!isProbe && !MANUAL_FORM_CLAUSES.includes(input.clauseId)) {
    throw new MeasureError('这条条款不在措施核验范围内', 'MEASURE_CLAUSE_UNKNOWN');
  }
  if (!getClause(input.clauseId)) throw new MeasureError('条款不存在', 'MEASURE_CLAUSE_UNKNOWN');
  if (!isConfirmedVerdict(input.verdict)) {
    throw new MeasureError('结论只能选符合、不符合或不适用', 'MEASURE_VERDICT_INVALID');
  }
  const existing = await db.standardMeasureCheck.findUnique({
    where: { runId_clauseId: { runId: input.runId, clauseId: input.clauseId } },
  });
  if (isProbe && !existing?.evidence) {
    throw new MeasureError('平台还没有取证，请先发起取证再确认', 'MEASURE_NO_EVIDENCE');
  }
  const note = input.note?.trim() || null;
  const data = {
    verdict: input.verdict,
    note,
    materials: input.materials?.trim() || null,
    confirmedById: input.reviewer.id,
    confirmedByName: input.reviewer.name,
    confirmedAt: new Date(),
  };
  return db.standardMeasureCheck.upsert({
    where: { runId_clauseId: { runId: input.runId, clauseId: input.clauseId } },
    create: { runId: input.runId, clauseId: input.clauseId, kind: isProbe ? 'PROBE' : 'FORM', ...data },
    update: data,
  });
}

export interface MeasureListItem {
  clauseId: string;
  title: string;
  ref: string;
  requirement: string;
  kind: 'PROBE' | 'FORM';
  /** 平台取证类：有没有取证；填报类恒为 false。 */
  hasEvidence: boolean;
  evidence: unknown;
  /** 平台取证类的自动结论（复核人确认过的以 verdict 为准）；填报类为 null。 */
  finding: ProbeFinding | null;
  verdict: string | null;
  note: string | null;
  materials: string | null;
  confirmedByName: string | null;
  confirmedAt: Date | null;
}

export async function listMeasures(db: PrismaClient, runId: string): Promise<MeasureListItem[]> {
  const rows = await db.standardMeasureCheck.findMany({ where: { runId } });
  const byClause = new Map(rows.map((r) => [r.clauseId, r]));
  return [...PROBE_CLAUSES, ...MANUAL_FORM_CLAUSES].flatMap((clauseId): MeasureListItem[] => {
    const clause = getClause(clauseId);
    if (!clause) return [];
    const row = byClause.get(clauseId);
    return [
      {
        clauseId,
        title: clause.title,
        ref: clause.ref,
        requirement: clause.requirement,
        kind: PROBE_CLAUSES.includes(clauseId) ? 'PROBE' : 'FORM',
        hasEvidence: Boolean(row?.evidence),
        evidence: row?.evidence ?? null,
        finding: PROBE_CLAUSES.includes(clauseId) ? probeFinding(clauseId, row?.evidence ?? null) : null,
        verdict: row?.verdict ?? null,
        note: row?.note ?? null,
        materials: row?.materials ?? null,
        confirmedByName: row?.confirmedByName ?? null,
        confirmedAt: row?.confirmedAt ?? null,
      },
    ];
  });
}
