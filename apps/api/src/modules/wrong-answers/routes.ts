import type { FastifyInstance, FastifyRequest } from 'fastify';
import { groupWrongAnswers, groupDetail, type RiskSample } from './groups.js';
import {
  FindingReviewStatus,
  Prisma,
  Severity,
  type Finding,
  type WrongAnswer,
} from '@prisma/client';
import { z } from 'zod';
import { RISK_DOMAIN, type Paginated } from '@lse/shared';
import { prisma } from '../../db.js';
import { AGENT_RISK_CATEGORIES, AGENT_RISK_ENGINES } from '../../lib/agent-risk.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { notFound } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { applyWorkbookWatermark, resolveDownloadWatermark } from '../../lib/data-security.js';
import { buildWrongAnswerWorkbook } from '../reports/excel.js';
import { SEVERITY_LABELS, resolveReportRiskDomain, riskLabel } from '../reports/labels.js';
import { remediationGuidance } from '../reports/remediation.js';
import { PENDING_REVIEW_STATUSES, reviewStatusFindingWhere } from '../dashboard/review-scope.js';
import { tenantFilterWhere } from '../../lib/all-tenants.js';

// 支持逗号分隔的多选风险等级过滤，例如 ?severity=HIGH,CRITICAL
const severityListParam = z
  .preprocess(
    (v) =>
      typeof v === 'string'
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : v,
    z.array(z.nativeEnum(Severity)),
  )
  .optional();

// 复核状态筛选：pending = 待复核（未复核 + 待人工复核，与首页「待复核」、我的待办同一口径，
// 排除失败/已取消任务）；all = 不限；也可逗号分隔具体状态，例如 ?reviewStatus=CONFIRMED,FALSE_POSITIVE。
// 不传 = 不限（与旧行为一致）。
const reviewStatusParam = z
  .preprocess(
    (v) =>
      typeof v === 'string'
        ? v
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean)
        : v,
    z.array(z.union([z.literal('pending'), z.literal('all'), z.nativeEnum(FindingReviewStatus)])),
  )
  .optional();

/** 解析为具体的复核状态集合；null 表示不限（走样本维度的旧列表）。 */
function resolveReviewStatuses(
  param: Array<'pending' | 'all' | FindingReviewStatus> | undefined,
): FindingReviewStatus[] | null {
  if (!param || param.length === 0 || param.includes('all')) return null;
  const set = new Set<FindingReviewStatus>();
  for (const item of param) {
    if (item === 'pending') PENDING_REVIEW_STATUSES.forEach((x) => set.add(x));
    else if (item !== 'all') set.add(item);
  }
  return [...set];
}

const findingIdsParam = z
  .preprocess(
    (value) =>
      typeof value === 'string'
        ? value
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean)
        : value,
    z.array(z.string().uuid()).max(200),
  )
  .optional();

const listQuery = z.object({
  taskId: z.string().uuid().optional(),
  tenantId: z.string().uuid().optional(),
  findingIds: findingIdsParam,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
  severity: severityListParam,
  agentRisk: z.coerce.boolean().optional(),
  reviewStatus: reviewStatusParam,
});

const exportQuery = z.object({
  taskId: z.string().uuid(),
  findingIds: findingIdsParam,
  severity: severityListParam,
  agentRisk: z.coerce.boolean().optional(),
  // 与风险处置台列表同口径：风险类别、按任务创建时间 [since, until)
  domain: z.enum(RISK_DOMAIN).optional(),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
});

const taskContextSelect = {
  id: true,
  name: true,
  modelTargetId: true,
  dimensions: true,
  engines: true,
  modelTarget: { select: { id: true, name: true, model: true, provider: true, targetType: true } },
  questionSets: {
    select: {
      questionSetId: true,
      questionSet: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.EvalTaskSelect;

const wrongAnswerInclude = {
  task: { select: taskContextSelect },
} satisfies Prisma.WrongAnswerInclude;

type WrongAnswerPayload = Prisma.WrongAnswerGetPayload<{ include: typeof wrongAnswerInclude }>;

function buildWhere(
  taskId?: string,
  severity?: Severity[],
  agentRisk?: boolean,
  findingIds?: string[],
): Prisma.WrongAnswerWhereInput {
  const where: Prisma.WrongAnswerWhereInput = {};
  if (taskId) where.taskId = taskId;
  if (findingIds?.length) where.result = { findings: { some: { id: { in: findingIds } } } };
  if (severity && severity.length > 0) where.severity = { in: severity };
  if (agentRisk) {
    where.OR = [
      { riskCategory: { in: [...AGENT_RISK_CATEGORIES] } },
      { engine: { in: [...AGENT_RISK_ENGINES] } },
    ];
  }
  return where;
}

type FindingIndex = {
  byKey: Map<string, Finding>;
  byResultId: Map<string, Finding[]>;
};

function findingForWrongAnswer(w: WrongAnswerPayload, findings: FindingIndex): Finding | undefined {
  return (
    findings.byKey.get(`${w.resultId}:${w.engine ?? ''}:${w.riskCategory ?? ''}`) ??
    findings.byKey.get(w.resultId)
  );
}

function evidenceFindingForWrongAnswer(
  w: WrongAnswerPayload,
  findings: FindingIndex,
): Finding | undefined {
  const primary = findingForWrongAnswer(w, findings);
  if (primary?.evidenceStrength || primary?.executionOutcome) return primary;
  return (
    findings.byResultId
      .get(w.resultId)
      ?.find((finding) => finding.evidenceStrength || finding.executionOutcome) ?? primary
  );
}

async function findingsForWrongAnswers(
  rows: Array<{ resultId: string | null }>,
): Promise<FindingIndex> {
  const resultIds = [
    ...new Set(rows.map((row) => row.resultId).filter((id): id is string => Boolean(id))),
  ];
  if (resultIds.length === 0) return { byKey: new Map(), byResultId: new Map() };
  const findings = await prisma.finding.findMany({
    where: { resultId: { in: resultIds } },
    orderBy: { createdAt: 'asc' },
  });
  const byKey = new Map<string, Finding>();
  const byResultId = new Map<string, Finding[]>();
  for (const finding of findings) {
    if (!finding.resultId) continue;
    byKey.set(`${finding.resultId}:${finding.engine}:${finding.riskCategory}`, finding);
    if (!byKey.has(finding.resultId)) byKey.set(finding.resultId, finding);
    const resultFindings = byResultId.get(finding.resultId) ?? [];
    resultFindings.push(finding);
    byResultId.set(finding.resultId, resultFindings);
  }
  return { byKey, byResultId };
}

function assessmentContext(task: WrongAnswerPayload['task']) {
  return {
    target: {
      id: task.modelTarget.id,
      name: task.modelTarget.name,
      version: task.modelTarget.model,
      provider: task.modelTarget.provider,
      targetType: task.modelTarget.targetType,
    },
    scope: {
      dimensions: task.dimensions,
      modules: task.engines,
      sampleSets: task.questionSets.map((item) => ({
        id: item.questionSet.id,
        name: item.questionSet.name,
      })),
    },
  };
}

/** 列表一行的公共字段；样本维度与风险项维度共用，保证两种列表给前端的结构一致。 */
interface ItemBase {
  id: string;
  tenantId?: string | null;
  taskId: string;
  task: WrongAnswerPayload['task'];
  resultId: string;
  questionId: string;
  questionContent: string;
  modelResponse: string | null;
  riskCategory: string | null;
  severity: Severity | null;
  verdict: string;
  reason: string | null;
  engine: string | null;
  createdAt: Date;
}

function buildItem(
  base: ItemBase,
  finding: Finding | undefined,
  evidenceFinding: Finding | undefined,
) {
  const guidance = remediationGuidance({
    riskCategory: finding?.riskCategory ?? base.riskCategory ?? 'unknown',
    engine: finding?.engine ?? base.engine,
    title: finding?.title ?? null,
    evidence: finding?.evidence ?? base.reason,
    reason: base.reason,
    questionContent: base.questionContent,
  });
  return {
    id: base.id,
    tenantId: base.tenantId ?? null,
    findingId: finding?.id ?? null,
    taskId: base.taskId,
    assessmentContext: assessmentContext(base.task),
    resultId: base.resultId,
    questionId: base.questionId,
    questionContent: base.questionContent,
    modelResponse: base.modelResponse,
    riskCategory: base.riskCategory,
    severity: base.severity,
    verdict: base.verdict,
    reason: base.reason,
    engine: base.engine,
    reviewStatus: finding?.reviewStatus ?? null,
    reviewReason: finding?.reviewReason ?? null,
    evidenceStrength: evidenceFinding?.evidenceStrength ?? null,
    executionOutcome: evidenceFinding?.executionOutcome ?? null,
    remediation: {
      ...guidance,
      status: finding?.remediationStatus ?? null,
      owner: finding?.remediationOwner ?? null,
      team: finding?.remediationTeam ?? null,
      controlLocation: finding?.remediationLocation ?? null,
      action: finding?.remediationAction ?? guidance.action,
      dueAt: finding?.remediationDueAt ?? null,
      record: finding?.remediationRecord ?? null,
      acceptanceCriteria: finding?.remediationAcceptanceCriteria ?? null,
      retestTaskId: finding?.remediationRetestTaskId ?? null,
      closureEvidence: finding?.remediationClosureEvidence ?? null,
      closedAt: finding?.remediationClosedAt ?? null,
    },
    createdAt: base.createdAt,
  };
}

function serialize(w: WrongAnswerPayload, findings: FindingIndex) {
  return buildItem(
    { ...w, verdict: w.verdict, resultId: w.resultId, questionId: w.questionId ?? '' },
    findingForWrongAnswer(w, findings),
    evidenceFindingForWrongAnswer(w, findings),
  );
}

// ───────────── 风险项维度的列表（传了 reviewStatus 时使用）─────────────

const findingListInclude = {
  task: { select: taskContextSelect },
  result: { select: { response: true } },
  question: { select: { content: true } },
} satisfies Prisma.FindingInclude;

type FindingListRow = Prisma.FindingGetPayload<{ include: typeof findingListInclude }>;

function buildFindingWhere(
  q: z.infer<typeof listQuery>,
  statuses: FindingReviewStatus[],
): Prisma.FindingWhereInput {
  const and: Prisma.FindingWhereInput[] = [reviewStatusFindingWhere(statuses)];
  if (q.taskId) and.push({ taskId: q.taskId });
  if (q.findingIds?.length) and.push({ id: { in: q.findingIds } });
  if (q.severity && q.severity.length > 0) and.push({ severity: { in: q.severity } });
  if (q.agentRisk) {
    and.push({
      OR: [
        { riskCategory: { in: [...AGENT_RISK_CATEGORIES] } },
        { engine: { in: [...AGENT_RISK_ENGINES] } },
      ],
    });
  }
  return { AND: and };
}

function serializeFinding(f: FindingListRow, w: WrongAnswer | undefined, index: FindingIndex) {
  // 优先用同一结果、同一引擎、同一类别的样本快照；没有快照（如终端体检发现）就用风险项自身的信息。
  const evidenceFinding =
    f.evidenceStrength || f.executionOutcome
      ? f
      : ((f.resultId
          ? index.byResultId.get(f.resultId)?.find((x) => x.evidenceStrength || x.executionOutcome)
          : undefined) ?? f);
  return buildItem(
    {
      // 行 id 必须唯一：同一条样本快照可能对应多个同引擎同类别的风险项，所以按风险项取 id。
      // 前端把 id 当列表 key 与敏感内容查看审计的 targetId，不依赖它指向 wrong_answers 表。
      id: `finding:${f.id}`,
      tenantId: f.tenantId ?? null,
      taskId: f.taskId,
      task: f.task as WrongAnswerPayload['task'],
      resultId: f.resultId ?? '',
      questionId: f.questionId ?? w?.questionId ?? '',
      questionContent: w?.questionContent ?? f.question?.content ?? f.title ?? '（无样本内容）',
      modelResponse: w ? w.modelResponse : (f.result?.response ?? null),
      riskCategory: f.riskCategory,
      severity: f.severity,
      verdict: w?.verdict ?? f.verdict,
      reason: w?.reason ?? f.evidence,
      engine: f.engine,
      createdAt: f.createdAt,
    },
    f,
    evidenceFinding,
  );
}

async function listByFinding(
  q: z.infer<typeof listQuery>,
  statuses: FindingReviewStatus[],
  request: FastifyRequest,
) {
  const where: Prisma.FindingWhereInput = {
    ...buildFindingWhere(q, statuses),
    ...tenantFilterWhere(request),
  };
  const [rows, total] = await Promise.all([
    prisma.finding.findMany({
      where,
      include: findingListInclude,
      orderBy: [
        { severity: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'desc' },
        { id: 'asc' },
      ],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
    prisma.finding.count({ where }),
  ]);
  const resultIds = [
    ...new Set(rows.map((r) => r.resultId).filter((id): id is string => Boolean(id))),
  ];
  const [answers, index] = await Promise.all([
    resultIds.length
      ? prisma.wrongAnswer.findMany({ where: { resultId: { in: resultIds } } })
      : Promise.resolve([] as WrongAnswer[]),
    findingsForWrongAnswers(rows),
  ]);
  const answerByKey = new Map<string, WrongAnswer>();
  for (const w of answers)
    answerByKey.set(`${w.resultId}:${w.engine ?? ''}:${w.riskCategory ?? ''}`, w);
  return {
    items: rows.map((f) =>
      serializeFinding(f, answerByKey.get(`${f.resultId}:${f.engine}:${f.riskCategory}`), index),
    ),
    total,
    page: q.page,
    pageSize: q.pageSize,
  } satisfies Paginated<ReturnType<typeof buildItem>>;
}

const groupsQuery = listQuery.extend({
  status: z.enum(['待确认', '整改中', '已关闭', '全部']).default('全部'),
  pageSize: z.coerce.number().int().min(1).max(200).default(15),
  // 风险类别（风险域编码），首页「风险类别分布」下钻用。
  domain: z.enum(RISK_DOMAIN).optional(),
  // 时间范围：按任务创建时间 [since, until)，与首页统计周期（dashboard/posture.ts taskScope）同口径。
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
});

/** 首页下钻的时间范围：按任务创建时间过滤，与首页「风险等级分布」「风险类别分布」一致。 */
function taskWindowWhere(q: z.infer<typeof groupsQuery>): { task?: Prisma.EvalTaskWhereInput } {
  if (!q.since && !q.until) return {};
  return {
    task: { createdAt: { ...(q.since ? { gte: q.since } : {}), ...(q.until ? { lt: q.until } : {}) } },
  };
}

/** 风险类别：与首页「风险类别分布」（dashboard/posture.ts buildRiskCategories）同一套归类。 */
function domainOf(riskCategory: string | null | undefined, engine: string | null | undefined): string {
  const code = riskCategory ?? '';
  const e = engine ?? undefined;
  return resolveReportRiskDomain({ riskCategory: code, riskCategoryLabel: riskLabel(code, e), engine: e });
}

function sampleDomain(s: RiskSample & { engine?: string | null }): string {
  return domainOf(s.riskCategory, s.engine);
}

/** 同时读取样本快照和未关联快照的发现，保留旧终端体检重复项供展示层归并。 */
async function loadGroupSamples(
  q: z.infer<typeof groupsQuery>,
  request: FastifyRequest,
): Promise<RiskSample[]> {
  const tenant = tenantFilterWhere(request);
  const taskWindow = taskWindowWhere(q);
  const [answers, findings] = await Promise.all([
    prisma.wrongAnswer.findMany({
      where: { ...buildWhere(q.taskId, undefined, q.agentRisk, q.findingIds), ...tenant, ...taskWindow },
      include: { ...wrongAnswerInclude, question: { select: { category: true, metadata: true } } },
      orderBy: { id: 'asc' },
    }),
    prisma.finding.findMany({
      where: {
        ...tenant,
        ...taskWindow,
        ...(q.taskId ? { taskId: q.taskId } : {}),
        ...(q.findingIds?.length ? { id: { in: q.findingIds } } : {}),
        ...(q.agentRisk ? { OR: [
          { riskCategory: { in: [...AGENT_RISK_CATEGORIES] } },
          { engine: { in: [...AGENT_RISK_ENGINES] } },
        ] } : {}),
      },
      include: { ...findingListInclude, question: { select: { content: true, category: true, metadata: true } } },
      orderBy: { id: 'asc' },
    }),
  ]);
  const index = await findingsForWrongAnswers(answers);
  const represented = new Set<string>();
  const samples: RiskSample[] = answers.map(w => {
    const related = findings.filter(f => f.resultId === w.resultId &&
      (f.engine === w.engine || !w.engine) && f.riskCategory === w.riskCategory);
    // 多个旧发现关联同一快照时，未处理项优先，不能被其中一个已关闭项掩盖。
    const stateRank = (f: Finding) =>
      ['FALSE_POSITIVE', 'ACCEPTED_RISK'].includes(f.reviewStatus) ||
      ['VERIFIED_CLOSED', 'NOT_APPLICABLE'].includes(f.remediationStatus) ? 2 :
      f.reviewStatus === 'CONFIRMED' || f.remediationStatus !== 'OPEN' ? 1 : 0;
    related.sort((a, b) => stateRank(a) - stateRank(b) || a.id.localeCompare(b.id));
    const primary = related[0];
    if (primary) represented.add(primary.id);
    related.forEach(f => represented.add(f.id));
    const item = buildItem({ ...w, questionId: w.questionId ?? '' }, primary,
      related.find(f => f.evidenceStrength || f.executionOutcome) ?? primary);
    // 风险类别按风险项的引擎归（样本快照可能没记引擎），与首页「风险类别分布」一致。
    return { ...item, engine: primary?.engine ?? w.engine, findingId: primary?.id ?? null,
      reviewStatus: primary?.reviewStatus ?? item.reviewStatus,
      remediation: { ...item.remediation, status: primary?.remediationStatus ?? item.remediation.status },
      question: w.question ? { category: w.question.category, metadata: w.question.metadata as Record<string, unknown> | null } : null,
      targetName: w.task.modelTarget.name,
      findingRefs: related.length ? related.map(f => ({ findingId: f.id, taskId: f.taskId })) :
        primary ? [{ findingId: primary.id, taskId: primary.taskId }] : [],
    };
  });
  for (const f of findings) {
    if (represented.has(f.id)) continue;
    const item = serializeFinding(f, undefined, index);
    samples.push({ ...item, title: f.title, suppressionKey: f.suppressionKey,
      question: f.question ? { category: f.question.category, metadata: f.question.metadata as Record<string, unknown> | null } : null,
      targetName: f.task.modelTarget.name });
  }
  const statuses = resolveReviewStatuses(q.reviewStatus);
  const linked = q.findingIds?.length ? samples.filter(s => Boolean(s.findingId)) : samples;
  const scoped = q.domain ? linked.filter(s => sampleDomain(s) === q.domain) : linked;
  return statuses ? scoped.filter(s => statuses.includes((s.reviewStatus ?? 'UNREVIEWED') as FindingReviewStatus)) : scoped;
}

export async function wrongAnswerRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get('/groups', { preHandler: [requirePermission('wrong_answer:export')] }, async request => {
    const q = groupsQuery.parse(request.query);
    const groups = groupWrongAnswers(await loadGroupSamples(q, request), { byTenant: request.currentUser!.allTenants === true });
    // 类别、时间已在取样本时过滤；等级按问题等级过滤，页签计数也在等级筛选之后算，与列表合计一致。
    const bySeverity = q.severity?.length ? groups.filter(g => q.severity!.includes(g.severity as Severity)) : groups;
    const counts = Object.fromEntries(['待确认', '整改中', '已关闭'].map(status => [status, bySeverity.filter(g => g.status === status).length]));
    const filtered = bySeverity.filter(g => q.status === '全部' || g.status === q.status);
    return { items: filtered.slice((q.page - 1) * q.pageSize, q.page * q.pageSize), total: filtered.length,
      page: q.page, pageSize: q.pageSize, counts };
  });
  app.get('/groups/:id', { preHandler: [requirePermission('wrong_answer:export')] }, async request => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(request.params);
    const q = groupsQuery.parse(request.query);
    const detail = groupDetail(await loadGroupSamples(q, request), id, q.page, q.pageSize, { byTenant: request.currentUser!.allTenants === true });
    if (!detail) throw notFound('问题不存在');
    return detail;
  });

  // 样本列表：默认严重度高在前、同级时间新在前。
  // 传 reviewStatus 时改按风险项（Finding）出列表：一个待复核风险项一行，条数与首页「待复核」、
  // 我的待办的合计完全一致（没有样本快照的风险项，如终端体检发现，也能在这里复核）。
  app.get('/', { preHandler: [requirePermission('wrong_answer:export')] }, async (request) => {
    const q = listQuery.parse(request.query);
    const statuses = resolveReviewStatuses(q.reviewStatus);
    if (statuses) return listByFinding(q, statuses, request);
    const where: Prisma.WrongAnswerWhereInput = {
      ...buildWhere(q.taskId, q.severity, q.agentRisk, q.findingIds),
      ...tenantFilterWhere(request),
    };
    const [items, total] = await Promise.all([
      prisma.wrongAnswer.findMany({
        where,
        include: wrongAnswerInclude,
        orderBy: [
          { severity: { sort: 'desc', nulls: 'last' } },
          { createdAt: 'desc' },
          { id: 'asc' },
        ],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.wrongAnswer.count({ where }),
    ]);
    const findings = await findingsForWrongAnswers(items);
    return {
      items: items.map((item) => serialize(item, findings)),
      total,
      page: q.page,
      pageSize: q.pageSize,
    } satisfies Paginated<ReturnType<typeof serialize>>;
  });

  // 导出样本集 Excel
  app.get(
    '/export',
    { preHandler: [requirePermission('wrong_answer:export')] },
    async (request, reply) => {
      const q = exportQuery.parse(request.query);
      const task = await prisma.evalTask.findUnique({ where: { id: q.taskId } });
      if (!task) throw notFound('评估任务不存在');

      const rows = await prisma.wrongAnswer.findMany({
        where: buildWhere(q.taskId, q.severity, q.agentRisk, q.findingIds),
        include: wrongAnswerInclude,
        orderBy: { createdAt: 'asc' },
      });
      // 文件名带上所选等级中文，便于客户区分（如 风险样本-高危-严重）
      const severitySuffix =
        q.severity && q.severity.length > 0
          ? '-' + q.severity.map((s) => SEVERITY_LABELS[s]).join('')
          : '';

      const findings = await findingsForWrongAnswers(rows);
      // 单个任务导出时，日期筛选只决定这个任务在不在范围内；类别按样本（优先取风险项的引擎）归类后过滤。
      const inWindow =
        (!q.since || task.createdAt >= q.since) && (!q.until || task.createdAt < q.until);
      const picked = !inWindow
        ? []
        : q.domain
          ? rows.filter(
              (w) =>
                domainOf(w.riskCategory, findingForWrongAnswer(w, findings)?.engine ?? w.engine) ===
                q.domain,
            )
          : rows;
      const wb = buildWrongAnswerWorkbook(
        task.name,
        picked.map((w) => {
          const finding = findingForWrongAnswer(w, findings);
          const evidenceFinding = evidenceFindingForWrongAnswer(w, findings);
          return {
            questionContent: w.questionContent,
            riskCategory: w.riskCategory,
            severity: w.severity,
            verdict: w.verdict,
            engine: w.engine,
            modelResponse: w.modelResponse,
            reason: w.reason,
            reviewStatus: finding?.reviewStatus ?? null,
            evidenceStrength: evidenceFinding?.evidenceStrength ?? null,
            executionOutcome: evidenceFinding?.executionOutcome ?? null,
            assessmentTarget: w.task.modelTarget.name,
            assessmentVersion: w.task.modelTarget.model,
            assessmentScope: [
              ...w.task.dimensions.map((item) => '维度:' + item),
              ...w.task.engines.map((item) => '模块:' + item),
              ...w.task.questionSets.map((item) => '样本集:' + item.questionSet.name),
            ].join('；'),
            ...(() => {
              const guidance = remediationGuidance({
                riskCategory: finding?.riskCategory ?? w.riskCategory ?? 'unknown',
                engine: finding?.engine ?? w.engine,
                title: finding?.title ?? null,
                evidence: finding?.evidence ?? w.reason,
                reason: w.reason,
                questionContent: w.questionContent,
              });
              return {
                ...guidance,
                action: finding?.remediationAction ?? guidance.action,
                responsibility:
                  finding?.remediationOwner ?? finding?.remediationTeam ?? guidance.responsibility,
                verification: finding?.remediationAcceptanceCriteria ?? guidance.verification,
                verificationScope: finding?.remediationLocation ?? guidance.verificationScope,
                status: finding?.remediationStatus ?? null,
                owner: finding?.remediationOwner ?? null,
                team: finding?.remediationTeam ?? null,
                controlLocation: finding?.remediationLocation ?? null,
                dueAt: finding?.remediationDueAt ?? null,
                record: finding?.remediationRecord ?? null,
                retestTaskId: finding?.remediationRetestTaskId ?? null,
                acceptanceCriteria: finding?.remediationAcceptanceCriteria ?? null,
                closureEvidence: finding?.remediationClosureEvidence ?? null,
                closedAt: finding?.remediationClosedAt ?? null,
              };
            })(),
            createdAt: w.createdAt,
          };
        }),
      );
      const watermark = await resolveDownloadWatermark(request.currentUser!);
      if (watermark) applyWorkbookWatermark(wb, watermark);
      const buf = await wb.xlsx.writeBuffer();

      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'wrong_answer.export',
        targetType: 'eval_task',
        targetId: q.taskId,
        detail: {
          count: picked.length,
          severity: q.severity && q.severity.length > 0 ? q.severity : '全部',
          ...(q.domain ? { domain: q.domain } : {}),
          ...(q.since ? { since: q.since.toISOString() } : {}),
          ...(q.until ? { until: q.until.toISOString() } : {}),
          watermark: watermark?.text ?? null,
        },
      });

      // ASCII 文件名兜底 + UTF-8 友好中文名（含所选等级），由前端按 Content-Disposition 命名。
      const utf8Name = encodeURIComponent(`风险样本-${task.name}${severitySuffix}.xlsx`);
      reply.header(
        'Content-Disposition',
        `attachment; filename="wrong-answers-${task.id}.xlsx"; filename*=UTF-8''${utf8Name}`,
      );
      reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write -- binary Excel export, not HTML rendering.
      return reply.send(Buffer.from(buf as unknown as Uint8Array));
    },
  );
}
