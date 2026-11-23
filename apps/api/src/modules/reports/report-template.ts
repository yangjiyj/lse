import type { ReportTemplate } from '@prisma/client';
import { prisma } from '../../db.js';
import { notFound } from '../../lib/errors.js';
import type { ReportEvidenceDetail } from './export-options.js';
import { REPORT_OPTIONAL_SECTIONS, type ReportSectionKey } from './labels.js';

// 报告模板（2.4.7）：章节取舍、封面（标题、抬头、检测单位、委托单位）、页眉页脚、密级、证据详略。
// 生成报告时把当时的模板内容快照进 summary.reportTemplate；下载时按「query > 快照 > 本租户默认 > 无」取用。

export const REPORT_EVIDENCE_DETAILS = ['none', 'summary', 'full'] as const;
export const DEFAULT_REPORT_CLASSIFICATION = '内部使用';

export interface ReportTemplateSnapshot {
  id: string;
  name: string;
  sections: ReportSectionKey[];
  evidenceDetail: ReportEvidenceDetail;
  coverTitle: string;
  coverKicker: string;
  organization: string;
  client: string;
  classification: string;
  headerText: string;
  footerText: string;
}

export interface ReportCoverOptions {
  title?: string;
  kicker?: string;
  organization?: string;
  client?: string;
}

export interface ReportPageOptions {
  headerText?: string;
  footerText?: string;
}

export interface ReportTemplateRenderOptions {
  templateId: string | null;
  /** 模板选了章节才有；空表示不限定（按报告原有范围） */
  sections?: ReportSectionKey[];
  evidenceDetail?: ReportEvidenceDetail;
  classification: string;
  cover: ReportCoverOptions;
  page: ReportPageOptions;
}

const isSection = (v: unknown): v is ReportSectionKey =>
  typeof v === 'string' && (REPORT_OPTIONAL_SECTIONS as readonly string[]).includes(v);
const isEvidence = (v: unknown): v is ReportEvidenceDetail =>
  typeof v === 'string' && (REPORT_EVIDENCE_DETAILS as readonly string[]).includes(v);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function templateSnapshot(t: ReportTemplate): ReportTemplateSnapshot {
  return {
    id: t.id,
    name: t.name,
    sections: t.sections.filter(isSection),
    evidenceDetail: isEvidence(t.evidenceDetail) ? t.evidenceDetail : 'full',
    coverTitle: t.coverTitle,
    coverKicker: t.coverKicker,
    organization: t.organization,
    client: t.client,
    classification: t.classification,
    headerText: t.headerText,
    footerText: t.footerText,
  };
}

/** 报告快照里的模板（旧报告没有）。 */
export function parseTemplateSnapshot(value: unknown): ReportTemplateSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string') return null;
  return {
    id: v.id,
    name: str(v.name),
    sections: Array.isArray(v.sections) ? v.sections.filter(isSection) : [],
    evidenceDetail: isEvidence(v.evidenceDetail) ? v.evidenceDetail : 'full',
    coverTitle: str(v.coverTitle),
    coverKicker: str(v.coverKicker),
    organization: str(v.organization),
    client: str(v.client),
    classification: str(v.classification),
    headerText: str(v.headerText),
    footerText: str(v.footerText),
  };
}

const nonEmpty = (text: string) => (text.trim() ? text.trim() : undefined);

/** 模板 → 渲染选项。没有模板时只有默认密级，其余都按现有默认。 */
export function templateRenderOptions(
  t: ReportTemplateSnapshot | null,
): ReportTemplateRenderOptions {
  if (!t) {
    return {
      templateId: null,
      classification: DEFAULT_REPORT_CLASSIFICATION,
      cover: {},
      page: {},
    };
  }
  const cover: ReportCoverOptions = {};
  const page: ReportPageOptions = {};
  if (nonEmpty(t.coverTitle)) cover.title = nonEmpty(t.coverTitle);
  if (nonEmpty(t.coverKicker)) cover.kicker = nonEmpty(t.coverKicker);
  if (nonEmpty(t.organization)) cover.organization = nonEmpty(t.organization);
  if (nonEmpty(t.client)) cover.client = nonEmpty(t.client);
  if (nonEmpty(t.headerText)) page.headerText = nonEmpty(t.headerText);
  if (nonEmpty(t.footerText)) page.footerText = nonEmpty(t.footerText);
  return {
    templateId: t.id,
    ...(t.sections.length > 0 ? { sections: [...t.sections] } : {}),
    evidenceDetail: t.evidenceDetail,
    classification: nonEmpty(t.classification) ?? DEFAULT_REPORT_CLASSIFICATION,
    cover,
    page,
  };
}

/**
 * 写进 CSS 字符串（@page 的 content:"…"）的文字：去掉换行和控制字符，转义反斜杠和双引号，
 * `<` 写成 `\3C `，用户文字不能结束字符串，也拼不出 `</style>`。
 */
export function cssString(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/</g, '\\3C ')
  );
}

/**
 * 下载时取用的模板：query 的 templateId > 生成时快照 > 报告所属租户的默认模板 > 无模板。
 * query 指定的模板不存在或不是报告所属租户的：404。
 */
export async function resolveReportTemplate(input: {
  templateId?: string;
  snapshot?: unknown;
  tenantId: string | null;
}): Promise<ReportTemplateSnapshot | null> {
  if (input.templateId) {
    const t = await prisma.reportTemplate.findUnique({ where: { id: input.templateId } });
    if (!t || (input.tenantId && t.tenantId !== input.tenantId)) {
      throw notFound('报告模板不存在', 'REPORT_TEMPLATE_NOT_FOUND');
    }
    return templateSnapshot(t);
  }
  const snapshot = parseTemplateSnapshot(input.snapshot);
  if (snapshot) return snapshot;
  const fallback = await prisma.reportTemplate.findFirst({
    where: { isDefault: true, ...(input.tenantId ? { tenantId: input.tenantId } : {}) },
  });
  return fallback ? templateSnapshot(fallback) : null;
}
