import { Prisma } from '@prisma/client';
import type { DetectCategory } from '@lse/shared';
import { prisma } from '../../db.js';
import { modelFileRule } from '../model-files/rules.js';
import { playbookForDomain } from '../reports/remediation-playbook.js';
import { riskDomainForCategory, riskDomainLabel } from '../reports/labels.js';
import { RISK_SOURCES, canReadRiskSource, type RiskSourceKey } from './sources.js';
import {
  RISK_SEVERITY_KEYS,
  aiComponentWhere,
  corpusWhere,
  evalFindingSql,
  modelFileWhere,
  serviceAssuranceWhere,
  scopeApplies,
  severityKey,
  type RiskCounter,
  type RiskSeverityKey,
} from './stats.js';

// 受测应用画像的处置建议（2.5.6）：按来源把有效风险分组，每组给一条处置动作；
// 按最高严重度、再按条数排序，最多 10 条。条件与四类风险计数同一份。

export const SUGGESTION_LIMIT = 10;

export interface RiskSuggestion {
  category: DetectCategory;
  source: RiskSourceKey;
  title: string;
  action: string;
  count: number;
  /** 这组里最高的严重度 */
  severity: RiskSeverityKey;
}
// action 可能为空字符串（组件扫描规则没有写处置），页面显示「—」。

const MODEL_FILE_ACTION =
  '停止在生产环境加载该文件，核对来源和哈希；改用官方发布文件或在隔离环境中重新转换后复扫';

const CORPUS_SUGGESTIONS: Record<string, { title: string; action: string }> = {
  violation: { title: '违规内容', action: '从训练语料中删除或改写命中记录后重新扫描' },
  sensitive: { title: '敏感信息', action: '用打码副本替换原语料，或删除含个人信息、凭据的记录' },
  custom: { title: '自定义规则命中', action: '按规则说明处置命中记录' },
};

const DISCOVERY_SUGGESTION = {
  title: '未登记 AI 服务',
  action: '登记为评估对象并纳入检测，或关停未授权的服务',
};

/** 评估风险项的处置：风险域对应处置手册「立即」第一步，有「短期」第一步时用「；」接上。 */
function evalAction(domain: ReturnType<typeof riskDomainForCategory>): string {
  const steps = playbookForDomain(domain).steps;
  return [steps.immediate[0], steps.short[0]].filter(Boolean).join('；');
}

interface Group {
  key: string;
  title: string;
  action: string;
  severity: string | null;
  n: number;
}

/** 一个来源的分组（同一 key 可能出现多次，按严重度拆开的）。 */
async function sourceGroups(source: RiskSourceKey, counter: RiskCounter): Promise<Group[]> {
  const { window: w, scope, tenantId } = counter;
  if (!scopeApplies(source, scope)) return [];
  switch (source) {
    case 'eval_content':
    case 'eval_app': {
      const category = source === 'eval_content' ? 'content' : 'app_env';
      const rows = await prisma.$queryRaw<
        Array<{ riskCategory: string; title: string | null; severity: string; n: number }>
      >(Prisma.sql`SELECT f."riskCategory" AS "riskCategory", f."title" AS title,
          f."severity"::text AS severity, count(*)::int AS n
        ${evalFindingSql(category, w, scope, tenantId)}
        GROUP BY 1, 2, 3
        ORDER BY n DESC
        LIMIT 5000`);
      return rows.map((r) => {
        const domain = riskDomainForCategory(r.riskCategory, r.title);
        return {
          key: domain,
          title: riskDomainLabel(domain),
          action: evalAction(domain),
          severity: r.severity,
          n: r.n,
        };
      });
    }
    case 'model_file': {
      const rows = await prisma.modelFileFinding.groupBy({
        by: ['ruleId', 'severity'],
        where: modelFileWhere(w, scope, tenantId),
        _count: { _all: true },
      });
      return rows.map((r) => ({
        key: r.ruleId,
        title: modelFileRule(r.ruleId)?.title ?? r.ruleId,
        action: MODEL_FILE_ACTION,
        severity: r.severity,
        n: r._count._all,
      }));
    }
    case 'corpus': {
      const rows = await prisma.corpusFinding.groupBy({
        by: ['category', 'severity'],
        where: corpusWhere(w, scope, tenantId),
        _count: { _all: true },
      });
      return rows.map((r) => {
        const s = CORPUS_SUGGESTIONS[r.category] ?? CORPUS_SUGGESTIONS.custom!;
        return { key: r.category, ...s, severity: r.severity, n: r._count._all };
      });
    }
    case 'service_assurance': {
      const rows = await prisma.vulnerabilityAssessment.groupBy({
        by: ['title', 'severity', 'remediation', 'fixedVersion'],
        where: serviceAssuranceWhere(w, scope, tenantId),
        _count: { _all: true },
      });
      return rows.map((r) => ({
        key: r.title,
        title: r.title,
        action:
          r.remediation ?? (r.fixedVersion ? `升级到 ${r.fixedVersion} 及以上` : '按漏洞公告处置'),
        severity: r.severity,
        n: r._count._all,
      }));
    }
    case 'ai_component': {
      const rows = await prisma.aiComponentFinding.groupBy({
        by: ['title', 'severity', 'remediation'],
        where: aiComponentWhere(w, scope, tenantId),
        _count: { _all: true },
      });
      return rows.map((r) => ({
        key: r.title,
        title: r.title,
        action: r.remediation.trim(),
        severity: r.severity,
        n: r._count._all,
      }));
    }
    case 'asset_discovery': {
      const { services } = await counter.unregistered();
      return services.length
        ? [{ key: 'unregistered', ...DISCOVERY_SUGGESTION, severity: 'HIGH', n: services.length }]
        : [];
    }
  }
}

/** 可见来源的处置建议，最多 SUGGESTION_LIMIT 条。范围、窗口、租户取 counter 的。 */
export async function riskSuggestions(
  can: (code: string) => boolean,
  counter: RiskCounter,
): Promise<RiskSuggestion[]> {
  const sources = (Object.keys(RISK_SOURCES) as RiskSourceKey[]).filter((s) =>
    canReadRiskSource(s, can),
  );
  const grouped = await Promise.all(sources.map((s) => sourceGroups(s, counter)));
  const merged = new Map<string, RiskSuggestion & { rank: number }>();
  sources.forEach((source, i) => {
    for (const g of grouped[i]!) {
      const severity = severityKey(g.severity);
      const rank = RISK_SEVERITY_KEYS.indexOf(severity);
      const id = `${source}|${g.key}`;
      const prev = merged.get(id);
      if (!prev) {
        merged.set(id, {
          category: RISK_SOURCES[source].category,
          source,
          title: g.title,
          action: g.action,
          count: g.n,
          severity,
          rank,
        });
        continue;
      }
      prev.count += g.n;
      if (!prev.action && g.action) prev.action = g.action;
      if (rank < prev.rank) Object.assign(prev, { rank, severity });
    }
  });
  return [...merged.values()]
    .sort((a, b) => a.rank - b.rank || b.count - a.count || a.title.localeCompare(b.title))
    .slice(0, SUGGESTION_LIMIT)
    .map((s) => ({
      category: s.category,
      source: s.source,
      title: s.title,
      action: s.action,
      count: s.count,
      severity: s.severity,
    }));
}
