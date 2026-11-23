/** AI 资产与外部扫描器的跨模块契约。 */
export const AI_ASSET_TYPES = ['SKILL', 'MCP_SERVER', 'AGENT', 'AI_INFRA', 'RELAY'] as const;
export type AiAssetType = (typeof AI_ASSET_TYPES)[number];

export const EVIDENCE_PROOFS = [
  'STATIC',
  'LLM_REVIEW',
  'DYNAMIC_CONFIRMED',
  'RUNTIME_OBSERVED',
] as const;
export type EvidenceProof = (typeof EVIDENCE_PROOFS)[number];

export const ASSESSMENT_STATUSES = ['PASS', 'FAIL', 'INCONCLUSIVE', 'ERROR', 'SKIPPED'] as const;
export type AssessmentStatus = (typeof ASSESSMENT_STATUSES)[number];

export interface EvidenceLocation {
  path?: string;
  startLine?: number;
  endLine?: number;
  pointer?: string;
}

export interface AssessmentEvidence {
  proof: EvidenceProof;
  source: string;
  location?: EvidenceLocation;
  excerpt?: string;
  traceId?: string;
  artifactSha256?: string;
  redacted?: boolean;
}

export interface TaxonomyReference {
  framework: string;
  id: string;
  label?: string;
  mappingVersion?: string;
}

export interface NormalizedAssetFinding {
  engine: string;
  assetType: AiAssetType;
  ruleId: string;
  riskCategory: string;
  title: string;
  severity: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  status: AssessmentStatus;
  confidence?: number | null;
  evidence: AssessmentEvidence[];
  taxonomy: TaxonomyReference[];
  remediation?: string;
}
