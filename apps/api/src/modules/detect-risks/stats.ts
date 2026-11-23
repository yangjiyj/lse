import { Prisma } from '@prisma/client';
import { DETECT_CATEGORIES, DETECT_CATEGORY_LABELS, type DetectCategory } from '@lse/shared';
import { prisma } from '../../db.js';
import { evalTaskDetectCategorySql, tenantCondition } from '../../lib/detect-sql.js';
import {
  ACTIVE_AI_COMPONENT_FINDING,
  ACTIVE_CORPUS_FINDING,
  ACTIVE_MODEL_FILE_FINDING,
  OPEN_VULNERABILITY_ASSESSMENT,
} from '../../lib/detect-risk-scope.js';
import {
  loadRegisteredTargets,
  matchHitModels,
  originOf,
  type RegisteredTarget,
} from '../asset-discovery/service.js';
import {
  RISK_SOURCES,
  RISK_SOURCES_BY_CATEGORY,
  canReadRiskSource,
  type RiskSourceKey,
} from './sources.js';

// 四类风险的计数口径（2.2.2）。逐来源的条件与现有页面的关系见 docs/detect-risk-categories.md。
// 评估类两个来源用原始 SQL（按任务类别分组），原始 SQL 不经租户查询扩展，自己带租户条件；
// 其余来源走 Prisma 租户扩展。tenantId 参数只在「全部租户」视角下按 ?tenantId= 筛选时传。

export type RiskSeverityKey = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO' | 'UNRATED';

/** 严重度从高到低，未定级在最后。 */
export const RISK_SEVERITY_KEYS: readonly RiskSeverityKey[] = [
  'CRITICAL',
  'HIGH',
  'MEDIUM',
  'LOW',
  'INFO',
  'UNRATED',
];

/** 有严重度的五级（Prisma Severity 枚举的取值）。 */
export const RATED_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;
export type RatedSeverity = (typeof RATED_SEVERITIES)[number];

export interface RiskCount {
  total: number;
  high: number;
  bySeverity: Record<RiskSeverityKey, number>;
}

export interface RiskWindow {
  since: Date | null;
  until: Date | null;
}

/** 画像用的范围：各字段之间是「或」；不传 scope 表示全租户。 */
export interface RiskScope {
  modelTargetIds?: string[];
  evalTaskIds?: string[];
  modelFileScanIds?: string[];
  corpusScanIds?: string[];
  aiComponentAssetKeys?: string[];
  assetDiscoveryRunIds?: string[];
  serviceAssuranceRunIds?: string[];
  hosts?: string[];
  origins?: string[];
}

export interface DetectRiskStats {
  categories: Array<{
    category: DetectCategory;
    label: string;
    total: number;
    high: number;
    sources: Array<{ source: RiskSourceKey; label: string; count: RiskCount | null }>;
  }>;
  /** 窗口内命中超过 50,000 条、只保存了一部分的语料扫描数（没有 corpus_scan:read 时为 0） */
  truncatedCorpusScans: number;
  /** 窗口内已完成的资产测绘超过 MAX_DISCOVERY_RUNS 次、只看了最近那些次（看不到资产测绘时为 false） */
  discoveryRunsTruncated: boolean;
}

export function emptySeverityCounts(): Record<RiskSeverityKey, number> {
  return { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0, UNRATED: 0 };
}

/** 各表的严重度（枚举、可空、语料的大写字符串）归到六档；空或认不出的算未定级。 */
export function severityKey(raw: string | null | undefined): RiskSeverityKey {
  return raw && (RATED_SEVERITIES as readonly string[]).includes(raw)
    ? (raw as RatedSeverity)
    : 'UNRATED';
}

function toCount(bySeverity: Record<RiskSeverityKey, number>): RiskCount {
  const total = RISK_SEVERITY_KEYS.reduce((sum, key) => sum + bySeverity[key], 0);
  return { total, high: bySeverity.CRITICAL + bySeverity.HIGH, bySeverity };
}

function tally(
  rows: Array<{ severity: string | null; n: number }>,
): Record<RiskSeverityKey, number> {
  const out = emptySeverityCounts();
  for (const row of rows) out[severityKey(row.severity)] += row.n;
  return out;
}

// ───────────────────────────── 各来源的条件（results.ts 共用） ─────────────────────────────

/** createdAt 条件：since 含、until 不含；都没有时不加条件。 */
export function windowFilter(w: RiskWindow): Prisma.DateTimeFilter | undefined {
  if (!w.since && !w.until) return undefined;
  return { ...(w.since ? { gte: w.since } : {}), ...(w.until ? { lt: w.until } : {}) };
}

const tenantWhere = (tenantId?: string) => (tenantId ? { tenantId } : {});

/**
 * 范围条件：没有 scope 不加；有 scope 时各字段「或」。一个可用字段都没有则一条不取，
 * 用 id in [] 表示（嵌套在关系过滤里的 OR: [] 不会被当成「不匹配」）。
 */
function scopeAny<T>(scope: RiskScope | undefined, conds: Array<T | false>): T[] {
  if (!scope) return [];
  const list = conds.filter((c): c is T => c !== false);
  return [(list.length ? { OR: list } : { id: { in: [] } }) as T];
}

const has = (list: string[] | undefined): list is string[] => Boolean(list && list.length > 0);

/**
 * 范围里有没有这个来源能用的字段。有 scope 但没有可用字段时这个来源一条不计，计数、取页、建议都不用再查库。
 * 没有 scope（全租户）时总是 true。
 */
export function scopeApplies(source: RiskSourceKey, scope?: RiskScope): boolean {
  if (!scope) return true;
  switch (source) {
    case 'eval_content':
    case 'eval_app':
      return has(scope.modelTargetIds) || has(scope.evalTaskIds);
    case 'model_file':
      return has(scope.modelTargetIds) || has(scope.modelFileScanIds);
    case 'corpus':
      return has(scope.corpusScanIds);
    case 'service_assurance':
      return has(scope.serviceAssuranceRunIds);
    case 'ai_component':
      return has(scope.aiComponentAssetKeys);
    case 'asset_discovery':
      return has(scope.assetDiscoveryRunIds) || has(scope.hosts) || has(scope.origins);
  }
}

/** 评估类（eval_content、eval_app）：FROM 与 WHERE，计数和明细共用。 */
export function evalFindingSql(
  category: 'content' | 'app_env',
  w: RiskWindow,
  scope?: RiskScope,
  tenantId?: string,
): Prisma.Sql {
  const conds: Prisma.Sql[] = [];
  if (has(scope?.modelTargetIds)) {
    conds.push(Prisma.sql`t."modelTargetId" = ANY(${scope!.modelTargetIds}::text[])`);
  }
  if (has(scope?.evalTaskIds)) conds.push(Prisma.sql`t."id" = ANY(${scope!.evalTaskIds}::text[])`);
  const scopeSql = !scope
    ? Prisma.empty
    : conds.length
      ? Prisma.sql`AND (${Prisma.join(conds, ' OR ')})`
      : Prisma.sql`AND false`;
  return Prisma.sql`FROM "findings" f JOIN "eval_tasks" t ON t."id" = f."taskId"
    WHERE f."severity" IS NOT NULL AND f."reviewStatus" <> 'FALSE_POSITIVE' AND f."verdict" <> 'PASS'
      AND ${evalTaskDetectCategorySql('t')} = ${category}
      ${w.since ? Prisma.sql`AND t."createdAt" >= ${w.since}` : Prisma.empty}
      ${w.until ? Prisma.sql`AND t."createdAt" < ${w.until}` : Prisma.empty}
      ${scopeSql}
      ${tenantCondition('t."tenantId"')}
      ${tenantId ? Prisma.sql`AND t."tenantId" = ${tenantId}` : Prisma.empty}`;
}

export function modelFileWhere(
  w: RiskWindow,
  scope?: RiskScope,
  tenantId?: string,
): Prisma.ModelFileFindingWhereInput {
  const createdAt = windowFilter(w);
  return {
    AND: [
      ACTIVE_MODEL_FILE_FINDING,
      tenantWhere(tenantId),
      ...(createdAt ? [{ scan: { createdAt } }] : []),
      ...scopeAny<Prisma.ModelFileFindingWhereInput>(scope, [
        has(scope?.modelTargetIds) && { scan: { targetId: { in: scope!.modelTargetIds } } },
        has(scope?.modelFileScanIds) && { scanId: { in: scope!.modelFileScanIds } },
      ]),
    ],
  };
}

/** 计入的语料扫描：已完成、在窗口内（truncatedCorpusScans 也用它）。 */
export function corpusScanWhere(
  w: RiskWindow,
  scope?: RiskScope,
  tenantId?: string,
): Prisma.CorpusScanWhereInput {
  const createdAt = windowFilter(w);
  return {
    AND: [
      { status: 'COMPLETED' },
      tenantWhere(tenantId),
      ...(createdAt ? [{ createdAt }] : []),
      ...scopeAny<Prisma.CorpusScanWhereInput>(scope, [
        has(scope?.corpusScanIds) && { id: { in: scope!.corpusScanIds } },
      ]),
    ],
  };
}

export function corpusWhere(
  w: RiskWindow,
  scope?: RiskScope,
  tenantId?: string,
): Prisma.CorpusFindingWhereInput {
  return {
    AND: [ACTIVE_CORPUS_FINDING, tenantWhere(tenantId), { scan: corpusScanWhere(w, scope) }],
  };
}

export function serviceAssuranceWhere(
  w: RiskWindow,
  scope?: RiskScope,
  tenantId?: string,
): Prisma.VulnerabilityAssessmentWhereInput {
  const createdAt = windowFilter(w);
  return {
    AND: [
      OPEN_VULNERABILITY_ASSESSMENT,
      tenantWhere(tenantId),
      ...(createdAt ? [{ run: { createdAt } }] : []),
      ...scopeAny<Prisma.VulnerabilityAssessmentWhereInput>(scope, [
        has(scope?.serviceAssuranceRunIds) && { runId: { in: scope!.serviceAssuranceRunIds } },
      ]),
    ],
  };
}

export function aiComponentWhere(
  w: RiskWindow,
  scope?: RiskScope,
  tenantId?: string,
): Prisma.AiComponentFindingWhereInput {
  const createdAt = windowFilter(w);
  return {
    AND: [
      ACTIVE_AI_COMPONENT_FINDING,
      tenantWhere(tenantId),
      ...(createdAt ? [{ scan: { createdAt } }] : []),
      ...scopeAny<Prisma.AiComponentFindingWhereInput>(scope, [
        has(scope?.aiComponentAssetKeys) && {
          scan: { assetKey: { in: scope!.aiComponentAssetKeys } },
        },
      ]),
    ],
  };
}

/** 未登记 AI 服务只看窗口内最近这么多次已完成的资产测绘（有范围时是范围内的最近这么多次）。 */
export const MAX_DISCOVERY_RUNS = 500;

export interface UnregisteredService {
  tenantId: string | null;
  origin: string;
  baseUrl: string;
  host: string;
  model: string | null;
  /** 最近一次命中的测绘 */
  runId: string;
  runCreatedAt: Date;
  runTargets: string[];
}

export interface UnregisteredServices {
  services: UnregisteredService[];
  /** 窗口内（有范围时为范围内）已完成的测绘超过 MAX_DISCOVERY_RUNS 次，只看了最近的那些 */
  truncated: boolean;
}

const discoveryRunSelect = {
  id: true,
  tenantId: true,
  createdAt: true,
  targets: true,
  hits: {
    orderBy: [{ host: 'asc' as const }, { port: 'asc' as const }],
    select: { host: true, baseUrl: true, models: true },
  },
} satisfies Prisma.AssetDiscoveryRunSelect;

/** 测绘与评估对象：一次读出，按范围在内存里精确比对（画像列表一页按租户共用一份）。 */
export interface DiscoveryData {
  runs: Array<Prisma.AssetDiscoveryRunGetPayload<{ select: typeof discoveryRunSelect }>>;
  truncated: boolean;
  targets: RegisteredTarget[];
}

const EMPTY_DISCOVERY: DiscoveryData = { runs: [], truncated: false, targets: [] };

/** origin 前缀的 LIKE 模式（小写，转义通配符）：库里预筛用，再在内存里按 origin 精确比对。 */
export function originLikePatterns(origins: string[]): string[] {
  return [
    ...new Set(
      origins.map((o) => `${(originOf(o) ?? o).toLowerCase().replace(/[\\%_]/g, '\\$&')}%`),
    ),
  ];
}

/**
 * 有范围时在库里预筛测绘的 id：run id 在范围里，或者有命中的 host 在范围里、baseUrl 以范围里的 origin 开头。
 * 用原始 SQL（lower(baseUrl) LIKE ANY 比 Prisma 的不区分大小写 startsWith 快一个数量级），带租户条件。
 */
async function scopedDiscoveryRunIds(
  w: RiskWindow,
  scope: RiskScope,
  tenantId?: string,
): Promise<string[]> {
  const runIds = scope.assetDiscoveryRunIds ?? [];
  const hosts = scope.hosts ?? [];
  const patterns = originLikePatterns(scope.origins ?? []);
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT r."id" FROM "asset_discovery_runs" r
    WHERE r."status" = 'COMPLETED'
      ${w.since ? Prisma.sql`AND r."createdAt" >= ${w.since}` : Prisma.empty}
      ${w.until ? Prisma.sql`AND r."createdAt" < ${w.until}` : Prisma.empty}
      ${tenantCondition('r."tenantId"')}
      ${tenantId ? Prisma.sql`AND r."tenantId" = ${tenantId}` : Prisma.empty}
      AND (r."id" = ANY(${runIds}::text[])
        OR EXISTS (SELECT 1 FROM "asset_discovery_hits" h WHERE h."runId" = r."id"
          AND (h."host" = ANY(${hosts}::text[]) OR lower(h."baseUrl") LIKE ANY(${patterns}::text[]))))
    ORDER BY r."createdAt" DESC, r."id" DESC
    LIMIT ${MAX_DISCOVERY_RUNS + 1}`);
  return rows.map((r) => r.id);
}

export async function loadDiscoveryData(
  w: RiskWindow,
  scope?: RiskScope,
  tenantId?: string,
): Promise<DiscoveryData> {
  if (scope && !scopeApplies('asset_discovery', scope)) return EMPTY_DISCOVERY;
  const createdAt = windowFilter(w);
  let truncated: boolean;
  let runs: DiscoveryData['runs'];
  if (scope) {
    const ids = await scopedDiscoveryRunIds(w, scope, tenantId);
    if (ids.length === 0) return EMPTY_DISCOVERY;
    truncated = ids.length > MAX_DISCOVERY_RUNS;
    runs = await prisma.assetDiscoveryRun.findMany({
      where: { id: { in: ids.slice(0, MAX_DISCOVERY_RUNS) } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: discoveryRunSelect,
    });
  } else {
    const found = await prisma.assetDiscoveryRun.findMany({
      where: { status: 'COMPLETED', ...tenantWhere(tenantId), ...(createdAt ? { createdAt } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_DISCOVERY_RUNS + 1,
      select: discoveryRunSelect,
    });
    if (found.length === 0) return EMPTY_DISCOVERY;
    truncated = found.length > MAX_DISCOVERY_RUNS;
    runs = found.slice(0, MAX_DISCOVERY_RUNS);
  }
  return { runs, truncated, targets: await loadRegisteredTargets() };
}

/** 把多个范围并成一个（画像列表按租户预读测绘用）。 */
export function mergeScopes(scopes: RiskScope[]): RiskScope {
  const out: Record<string, Set<string>> = {};
  for (const scope of scopes) {
    for (const [key, list] of Object.entries(scope)) {
      for (const v of (list as string[] | undefined) ?? []) (out[key] ??= new Set()).add(v);
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v]])) as RiskScope;
}

/**
 * 未登记 AI 服务：已完成测绘的命中里，按资产测绘详情页同一判断（matchHitModels）没对上评估对象的，
 * 按 origin + 模型名跨次去重，留最近一次命中。按最近命中时间倒序。
 * 评估对象只和测绘同租户（或平台共享）的比，全部租户视角下也不串租户。
 */
export function matchUnregistered(data: DiscoveryData, scope?: RiskScope): UnregisteredServices {
  const runIds = new Set(scope?.assetDiscoveryRunIds ?? []);
  const hosts = new Set(scope?.hosts ?? []);
  const origins = new Set((scope?.origins ?? []).map((o) => originOf(o) ?? o.toLowerCase()));
  const out = new Map<string, UnregisteredService>();
  let truncated = data.truncated;
  for (const run of data.runs) {
    const candidates = data.targets.filter((t) => !t.tenantId || t.tenantId === run.tenantId);
    for (const hit of run.hits) {
      const origin = originOf(hit.baseUrl) ?? hit.baseUrl;
      if (scope && !runIds.has(run.id) && !hosts.has(hit.host) && !origins.has(origin)) continue;
      for (const row of matchHitModels(hit.baseUrl, hit.models, candidates)) {
        if (row.registered) continue;
        const key = `${run.tenantId ?? ''}|${origin}|${row.model ?? ''}`;
        if (out.has(key)) continue;
        out.set(key, {
          tenantId: run.tenantId,
          origin,
          baseUrl: hit.baseUrl,
          host: hit.host,
          model: row.model,
          runId: run.id,
          runCreatedAt: run.createdAt,
          runTargets: run.targets,
        });
      }
    }
  }
  if (scope && !scopeApplies('asset_discovery', scope)) truncated = false;
  return { services: [...out.values()], truncated };
}

export async function unregisteredServices(
  w: RiskWindow,
  scope?: RiskScope,
  tenantId?: string,
): Promise<UnregisteredServices> {
  return matchUnregistered(await loadDiscoveryData(w, scope, tenantId), scope);
}

// ───────────────────────────── 计数 ─────────────────────────────

/** 除资产测绘外各来源按严重度分组计数。 */
async function querySeverityCounts(
  source: Exclude<RiskSourceKey, 'asset_discovery'>,
  w: RiskWindow,
  scope?: RiskScope,
  tenantId?: string,
): Promise<Record<RiskSeverityKey, number>> {
  if (!scopeApplies(source, scope)) return emptySeverityCounts();
  switch (source) {
    case 'eval_content':
    case 'eval_app': {
      const category = source === 'eval_content' ? 'content' : 'app_env';
      const rows = await prisma.$queryRaw<Array<{ severity: string; n: number }>>(
        Prisma.sql`SELECT f."severity"::text AS severity, count(*)::int AS n
          ${evalFindingSql(category, w, scope, tenantId)}
          GROUP BY 1`,
      );
      return tally(rows);
    }
    case 'model_file': {
      const rows = await prisma.modelFileFinding.groupBy({
        by: ['severity'],
        where: modelFileWhere(w, scope, tenantId),
        _count: { _all: true },
      });
      return tally(rows.map((r) => ({ severity: r.severity, n: r._count._all })));
    }
    case 'corpus': {
      const rows = await prisma.corpusFinding.groupBy({
        by: ['severity'],
        where: corpusWhere(w, scope, tenantId),
        _count: { _all: true },
      });
      return tally(rows.map((r) => ({ severity: r.severity, n: r._count._all })));
    }
    case 'service_assurance': {
      const rows = await prisma.vulnerabilityAssessment.groupBy({
        by: ['severity'],
        where: serviceAssuranceWhere(w, scope, tenantId),
        _count: { _all: true },
      });
      return tally(rows.map((r) => ({ severity: r.severity, n: r._count._all })));
    }
    case 'ai_component': {
      const rows = await prisma.aiComponentFinding.groupBy({
        by: ['severity'],
        where: aiComponentWhere(w, scope, tenantId),
        _count: { _all: true },
      });
      return tally(rows.map((r) => ({ severity: r.severity, n: r._count._all })));
    }
  }
}

export interface RiskCounterOptions {
  /** 预先读好的测绘与评估对象（画像列表一页按租户共用）；不传时按范围自己读 */
  discovery?: Promise<DiscoveryData>;
}

/**
 * 一次请求里的计数：窗口、范围、租户定好后，同一来源只算一次，未登记 AI 服务只查一次；
 * 检测结果接口用同一个实例算来源合计和取页，统计、画像、处置建议也都用它。
 * 第一次调用要在租户范围里（请求处理或 runInTenant 里）。
 */
export class RiskCounter {
  private readonly counts = new Map<RiskSourceKey, Promise<Record<RiskSeverityKey, number>>>();
  private discovery: Promise<UnregisteredServices> | undefined;

  constructor(
    readonly window: RiskWindow,
    readonly scope?: RiskScope,
    readonly tenantId?: string,
    private readonly options: RiskCounterOptions = {},
  ) {}

  unregistered(): Promise<UnregisteredServices> {
    this.discovery ??= (
      this.options.discovery ?? loadDiscoveryData(this.window, this.scope, this.tenantId)
    ).then((data) => matchUnregistered(data, this.scope));
    return this.discovery;
  }

  /** 某来源按严重度的计数（未定级单列）。 */
  severityCounts(source: RiskSourceKey): Promise<Record<RiskSeverityKey, number>> {
    let pending = this.counts.get(source);
    if (!pending) {
      pending =
        source === 'asset_discovery'
          ? this.unregistered().then(({ services }) => ({
              ...emptySeverityCounts(),
              HIGH: services.length,
            }))
          : querySeverityCounts(source, this.window, this.scope, this.tenantId);
      this.counts.set(source, pending);
    }
    return pending;
  }

  async count(source: RiskSourceKey): Promise<RiskCount> {
    return toCount(await this.severityCounts(source));
  }
}

/** 某来源按严重度的计数（未定级单列）。 */
export function riskSeverityCounts(
  source: RiskSourceKey,
  w: RiskWindow,
  scope?: RiskScope,
  tenantId?: string,
): Promise<Record<RiskSeverityKey, number>> {
  return new RiskCounter(w, scope, tenantId).severityCounts(source);
}

export async function countRiskSource(
  source: RiskSourceKey,
  w: RiskWindow,
  scope?: RiskScope,
  tenantId?: string,
): Promise<RiskCount> {
  return new RiskCounter(w, scope, tenantId).count(source);
}

/** 四类统计；窗口、范围、租户取 counter 的。 */
export async function detectRiskStats(
  can: (code: string) => boolean,
  counter: RiskCounter,
): Promise<DetectRiskStats> {
  const { window: w, scope, tenantId } = counter;
  const canDiscovery = canReadRiskSource('asset_discovery', can);
  const [categories, truncatedCorpusScans, discoveryRunsTruncated] = await Promise.all([
    Promise.all(
      DETECT_CATEGORIES.map(async (category) => {
        const sources = await Promise.all(
          RISK_SOURCES_BY_CATEGORY[category].map(async (source) => ({
            source,
            label: RISK_SOURCES[source].label,
            count: canReadRiskSource(source, can) ? await counter.count(source) : null,
          })),
        );
        return {
          category,
          label: DETECT_CATEGORY_LABELS[category],
          total: sources.reduce((sum, s) => sum + (s.count?.total ?? 0), 0),
          high: sources.reduce((sum, s) => sum + (s.count?.high ?? 0), 0),
          sources,
        };
      }),
    ),
    canReadRiskSource('corpus', can) && scopeApplies('corpus', scope)
      ? prisma.corpusScan.count({
          where: { AND: [corpusScanWhere(w, scope, tenantId), { truncated: true }] },
        })
      : Promise.resolve(0),
    canDiscovery ? counter.unregistered().then((d) => d.truncated) : Promise.resolve(false),
  ]);
  return { categories, truncatedCorpusScans, discoveryRunsTruncated };
}
