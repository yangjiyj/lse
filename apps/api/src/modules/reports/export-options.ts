import type { RiskDomain, Severity } from '@lse/shared';
import {
  REPORT_OPTIONAL_SECTIONS,
  riskDomainForCategory,
  riskDomainLabel,
  type ReportSectionKey,
} from './labels.js';
import type { RiskItemSeverityGroup } from './report-builder.js';

export const REPORT_EXPORT_PROFILES = [
  'full',
  'leadership_brief',
  'remediation_work_order',
  'compliance_evidence',
] as const;

export type ReportExportProfile = (typeof REPORT_EXPORT_PROFILES)[number];
export type ReportEvidenceDetail = 'none' | 'summary' | 'full';

interface ProfileDefaults {
  sections: ReportSectionKey[];
  evidenceDetail: ReportEvidenceDetail;
}

const PROFILE_DEFAULTS: Record<ReportExportProfile, ProfileDefaults> = {
  full: {
    sections: [...REPORT_OPTIONAL_SECTIONS],
    evidenceDetail: 'full',
  },
  leadership_brief: {
    sections: ['resultOverview', 'remediation', 'nextSteps'],
    evidenceDetail: 'none',
  },
  remediation_work_order: {
    sections: ['riskItems', 'remediation', 'nextSteps'],
    evidenceDetail: 'summary',
  },
  compliance_evidence: {
    sections: ['riskItems', 'gbtCompliance', 'appendix'],
    evidenceDetail: 'full',
  },
};

/**
 * 新增的可选章节默认全选：存量报告保存的 sectionScope 里没有这些章节，
 * 下载时补入，避免旧快照渲染出的新版报告缺少「结果总览」。
 */
export function withNewDefaultSections(
  sections: ReportSectionKey[] | undefined,
): ReportSectionKey[] | undefined {
  if (!sections) return sections;
  return sections.includes('resultOverview') ? sections : ['resultOverview', ...sections];
}

export interface ReportExportInput {
  profile?: ReportExportProfile;
  sections?: ReportSectionKey[];
  severityFilter?: Severity[];
  riskDomainFilter?: RiskDomain[];
}

export interface ResolvedReportExportOptions {
  profile: ReportExportProfile;
  sections: ReportSectionKey[];
  evidenceDetail: ReportEvidenceDetail;
  severityFilter?: Severity[];
  riskDomainFilter?: RiskDomain[];
}

export function resolveReportExportOptions(
  input: ReportExportInput = {},
): ResolvedReportExportOptions {
  const profile = input.profile ?? 'full';
  const defaults = PROFILE_DEFAULTS[profile];
  return {
    profile,
    sections: input.sections ? [...input.sections] : [...defaults.sections],
    evidenceDetail: defaults.evidenceDetail,
    ...(input.severityFilter?.length ? { severityFilter: [...input.severityFilter] } : {}),
    ...(input.riskDomainFilter?.length ? { riskDomainFilter: [...input.riskDomainFilter] } : {}),
  };
}

export function filterRiskItemGroups(
  groups: RiskItemSeverityGroup[],
  filters: Pick<ResolvedReportExportOptions, 'severityFilter' | 'riskDomainFilter'>,
): RiskItemSeverityGroup[] {
  const severitySet = filters.severityFilter?.length
    ? new Set<Severity>(filters.severityFilter)
    : null;
  const domainSet = filters.riskDomainFilter?.length
    ? new Set<RiskDomain>(filters.riskDomainFilter)
    : null;

  return groups
    .filter((group) =>
      severitySet ? group.severity !== 'UNSPECIFIED' && severitySet.has(group.severity) : true,
    )
    .map((group) => {
      const normalizedItems = group.items.map((item) => {
        const storedDomain = (item as { riskDomain?: RiskDomain }).riskDomain;
        const domain =
          storedDomain ??
          riskDomainForCategory(
            item.riskCategoryLabel,
            `${item.questionContent} ${item.riskExplanation}`,
          );
        return {
          ...item,
          riskDomain: domain,
          riskDomainLabel:
            (item as { riskDomainLabel?: string }).riskDomainLabel ?? riskDomainLabel(domain),
        };
      });
      return {
        ...group,
        items: domainSet
          ? normalizedItems.filter((item) => domainSet.has(item.riskDomain))
          : normalizedItems,
      };
    })
    .filter((group) => group.items.length > 0);
}
