import { ATLAS_DATA, OWASP_DATA, RISK_DOMAIN_ATLAS_TECHNIQUES } from '../frameworks/index.js';
import { COMPLIANCE_MAP, GBT45654_ANNEX_A_LABELS, ATLAS_TACTIC } from './compliance-mapping.js';
import { RISK_DOMAIN_LABELS, type RiskDomain } from '@lse/shared';

export interface InternationalFrameworkRow {
  riskDomain: string;
  riskDomainLabel: string;
  framework: string;
  entryId: string;
  entryNameEn: string;
  entryNameZh: string;
  evidenceStatus: string;
}

export function buildInternationalFrameworkSection(riskDomains: string[]): InternationalFrameworkRow[] {
  const matrix = ATLAS_DATA.matrices[0];
  if (!matrix) return [];
  const atlas = new Map(matrix.techniques.flatMap(({ id, name }) => [[id, name] as const]));
  const tacticIds = new Map(matrix.tactics.map(({ id, name }) => [name.toLowerCase(), id]));
  const rows: InternationalFrameworkRow[] = [];
  for (const domain of [...new Set(riskDomains)]) {
    const mapping = COMPLIANCE_MAP[domain as keyof typeof COMPLIANCE_MAP];
    if (!mapping) continue;
    for (const code of mapping.owasp) {
      const item = OWASP_DATA.llm.items.find((entry) => entry.id === code);
      if (item) rows.push({ riskDomain: domain, riskDomainLabel: RISK_DOMAIN_LABELS[domain as RiskDomain], framework: 'OWASP LLM Top 10 2025', entryId: code, entryNameEn: item.nameEn, entryNameZh: item.nameZh, evidenceStatus: '平台参考映射，需结合证据核验' });
    }
    for (const code of mapping.gbt45654) {
      rows.push({ riskDomain: domain, riskDomainLabel: RISK_DOMAIN_LABELS[domain as RiskDomain], framework: 'GB/T 45654 附录A', entryId: code, entryNameEn: '', entryNameZh: GBT45654_ANNEX_A_LABELS[code] ?? code, evidenceStatus: '平台参考映射，需结合证据核验' });
    }
    for (const threat of mapping.agentic) {
      const item = OWASP_DATA.agentic.items.find((entry) => entry.nameZh === threat);
      if (item) rows.push({ riskDomain: domain, riskDomainLabel: RISK_DOMAIN_LABELS[domain as RiskDomain], framework: 'OWASP Agentic Applications 2025', entryId: item.id, entryNameEn: item.nameEn, entryNameZh: item.nameZh, evidenceStatus: '平台参考映射，需结合证据核验' });
    }
    for (const nameZh of mapping.atlas) {
      const tacticKey = Object.entries(ATLAS_TACTIC).find(([, zh]) => zh === nameZh)?.[0];
      const enName = tacticKey ? ATLAS_TACTIC_EN[tacticKey] : undefined;
      const id = enName ? tacticIds.get(enName.toLowerCase()) : undefined;
      if (id) rows.push({ riskDomain: domain, riskDomainLabel: RISK_DOMAIN_LABELS[domain as RiskDomain], framework: 'MITRE ATLAS v2026.09', entryId: id, entryNameEn: enName!, entryNameZh: nameZh, evidenceStatus: '平台参考映射，需结合证据核验' });
    }
    for (const code of RISK_DOMAIN_ATLAS_TECHNIQUES[domain] ?? []) {
      rows.push({ riskDomain: domain, riskDomainLabel: RISK_DOMAIN_LABELS[domain as RiskDomain], framework: 'MITRE ATLAS v2026.09', entryId: code, entryNameEn: atlas.get(code) ?? '', entryNameZh: '', evidenceStatus: '平台参考映射，需结合证据核验' });
    }
  }
  return rows;
}

const ATLAS_TACTIC_EN: Record<string, string> = {
  reconnaissance: 'Reconnaissance', resourceDev: 'Resource Development', initialAccess: 'Initial Access',
  modelAccess: 'AI Model Access', execution: 'Execution', persistence: 'Persistence',
  privilegeEscalation: 'Privilege Escalation', defenseEvasion: 'Defense Evasion', credentialAccess: 'Credential Access',
  discovery: 'Discovery', collection: 'Collection', exfiltration: 'Exfiltration', impact: 'Impact',
};
