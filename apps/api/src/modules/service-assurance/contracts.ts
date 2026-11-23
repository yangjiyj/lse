import {
  SERVICE_ASSURANCE_MODES,
  SERVICE_ASSURANCE_TARGET_KINDS,
  type ServiceAssuranceTargetKind,
  AssuranceEvidenceLevel,
  AssuranceImpactStatus,
  AssurancePriority,
  ServiceAssuranceCoverageStatus,
  ServiceAssuranceCustomerSummary,
  ServiceAssuranceMode,
  ServiceAssuranceNotice,
  ServiceAssuranceExecutionRecord,
  Severity,
} from '@lse/shared';
import { z } from 'zod';
import { SERVICE_ASSURANCE_SBOM_LIMITS } from './sbom.js';

export const SERVICE_ASSURANCE_REQUEST_BUDGET = Object.freeze({
  maxRequests: 200,
  maxConcurrency: 4,
  requestTimeoutMs: 10_000,
  totalTimeoutMs: 120_000,
  maxResponseBytes: 1_048_576,
  maxRedirects: 0,
});

const SENSITIVE_TARGET_QUERY_KEY =
  /^(?:api[-_]?key|access[-_]?token|auth(?:orization)?|bearer|token|signature|sig|secret)$/i;

const targetUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2_048)
  .superRefine((value, ctx) => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '目标地址仅允许无凭据、无片段的 HTTP/S URL',
      });
    }
    if ([...url.searchParams.keys()].some((key) => SENSITIVE_TARGET_QUERY_KEY.test(key))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '目标地址不能包含密钥、令牌或签名查询参数，请使用凭据引用',
      });
    }
  });

export const serviceAssuranceSbomUploadSchema = z
  .object({
    contentType: z.string().trim().min(1).max(200),
    content: z.string().max(SERVICE_ASSURANCE_SBOM_LIMITS.maxBytes),
  })
  .strict();

export const serviceAssuranceCreateBodySchema = z
  .object({
    /** 可选：不关联评估任务时核验记录归属发起人，需要纳入报告时再关联。 */
    taskId: z.string().uuid().optional(),
    mode: z.enum(SERVICE_ASSURANCE_MODES),
    targetKind: z.enum(SERVICE_ASSURANCE_TARGET_KINDS),
    targetName: z.string().trim().min(1).max(200),
    targetUrl: targetUrlSchema.optional(),
    scopePolicyRef: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    credentialRef: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
      .optional(),
    authorizationConfirmed: z.boolean().default(false),
    sbom: serviceAssuranceSbomUploadSchema.optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const sbomTarget = body.targetKind === ('SBOM' satisfies ServiceAssuranceTargetKind);
    if ((body.mode === 'SBOM') !== sbomTarget) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetKind'],
        message: 'SBOM 模式必须使用 SBOM 目标，其他模式不能使用 SBOM 目标',
      });
    }
    if (!sbomTarget && !body.targetUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetUrl'],
        message: '服务目标必须提供目标地址',
      });
    }
    if (sbomTarget && !body.sbom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sbom'],
        message: 'SBOM 模式必须提供标准组件清单',
      });
    }
    if (!sbomTarget && body.sbom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sbom'],
        message: '非 SBOM 模式不能携带组件清单',
      });
    }
    if (sbomTarget && (body.targetUrl || body.credentialRef || body.authorizationConfirmed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetKind'],
        message: 'SBOM 模式不能携带远程目标、凭据或主动核验授权',
      });
    }
  });

export type ServiceAssuranceCreateBody = z.infer<typeof serviceAssuranceCreateBodySchema>;

export interface ServiceAssetDraft {
  customerName: string;
  normalizedAddress: string;
  protocol: string | null;
  host: string | null;
  port: number | null;
  title: string | null;
  assetKey: string;
}

export interface ServiceComponentDraft {
  assetKey: string;
  name: string;
  vendor: string | null;
  version: string | null;
  purl: string | null;
  cpe: string | null;
  hashes: Record<string, string> | null;
  source: string;
  confidence: number;
  evidenceLevel: AssuranceEvidenceLevel;
  componentKey: string;
}

export interface VulnerabilityAssessmentDraft {
  assetKey: string;
  componentKey: string | null;
  advisoryId: string | null;
  title: string;
  severity: Severity | null;
  cvss: number | null;
  fixedVersion: string | null;
  kev: boolean | null;
  epss: number | null;
  impactStatus: AssuranceImpactStatus;
  evidenceLevel: AssuranceEvidenceLevel;
  confidence: number;
  priority: AssurancePriority;
  reason: string;
  remediation: string | null;
  assessmentKey: string;
}

export interface ServiceEvidenceDraft {
  assessmentKey: string;
  componentKey: string | null;
  evidenceType: string;
  sourceTool: string;
  ruleId: string | null;
  ruleSummary: string | null;
  matchedLocation: string | null;
  extractedValue: string | null;
  customerSummary: string;
  requestSummary: string | null;
  responseSummary: string | null;
  contentSha256: string;
  visibility: 'CUSTOMER' | 'TECHNICAL' | 'AUDIT_ONLY';
}

export interface NucleiNormalizationResult {
  execution?: ServiceAssuranceExecutionRecord;
  mode: ServiceAssuranceMode;
  coverageStatus: ServiceAssuranceCoverageStatus;
  invalidLineCount: number;
  eventsProcessed: number;
  assets: ServiceAssetDraft[];
  components: ServiceComponentDraft[];
  assessments: VulnerabilityAssessmentDraft[];
  evidence: ServiceEvidenceDraft[];
  notices: ServiceAssuranceNotice[];
  customerSummary: ServiceAssuranceCustomerSummary;
}

export interface ServiceAssuranceFindingDraft {
  engine: 'service-assurance';
  riskCategory: 'service_vulnerability';
  severity: Severity | null;
  score: number | null;
  verdict: 'FAIL';
  confidence: number;
  reviewStatus: 'NEEDS_REVIEW';
  suppressionKey: string;
  title: string;
  evidence: string;
  detail: {
    v: 1;
    impactStatus: 'AFFECTED';
    evidenceLevel: Exclude<AssuranceEvidenceLevel, 'LEAD'>;
    advisoryId: string | null;
    priority: AssurancePriority;
  };
}
