import type { AssuranceEvidenceLevel } from '@lse/shared';
import type { ServiceAssuranceFindingDraft, VulnerabilityAssessmentDraft } from './contracts.js';

const EVIDENCE_RANK: Record<AssuranceEvidenceLevel, number> = {
  LEAD: 0,
  VERSION_MATCH: 1,
  CONFIG_MATCH: 2,
  ACTIVE_VERIFIED: 3,
};

export function toFormalFindingDraft(
  assessment: VulnerabilityAssessmentDraft,
): ServiceAssuranceFindingDraft | null {
  if (assessment.impactStatus !== 'AFFECTED') return null;
  if (EVIDENCE_RANK[assessment.evidenceLevel] < EVIDENCE_RANK.VERSION_MATCH) return null;

  return {
    engine: 'service-assurance',
    riskCategory: 'service_vulnerability',
    severity: assessment.severity,
    score: assessment.cvss,
    verdict: 'FAIL',
    confidence: assessment.confidence,
    reviewStatus: 'NEEDS_REVIEW',
    suppressionKey: assessment.assessmentKey,
    title: assessment.title,
    evidence: assessment.reason,
    detail: {
      v: 1,
      impactStatus: 'AFFECTED',
      evidenceLevel: assessment.evidenceLevel as Exclude<AssuranceEvidenceLevel, 'LEAD'>,
      advisoryId: assessment.advisoryId,
      priority: assessment.priority,
    },
  };
}
