import atlas from './data/atlas-v2026.09.json' with { type: 'json' };
import owasp from './data/owasp.json' with { type: 'json' };
import atlasZh from './data/atlas-zh.json' with { type: 'json' };

export const ATLAS_DATA = atlas;
export const OWASP_DATA = owasp;
export const ATLAS_ZH_DATA = atlasZh as {
  tactics: Record<string, string>;
  techniques: Record<string, string>;
};

/** ATLAS 技术的平台中文译名；没有可靠译法的返回空串，由界面保留英文原名。 */
export function atlasTechniqueZh(id: string): string {
  return ATLAS_ZH_DATA.techniques[id] ?? '';
}
export function atlasTacticZh(id: string): string {
  return ATLAS_ZH_DATA.tactics[id] ?? '';
}
export const ATLAS_TECHNIQUE_IDS = new Set(
  atlas.matrices.flatMap((matrix) => matrix.techniques.map((item) => item.id)),
);

export const RISK_DOMAIN_ATLAS_TECHNIQUES: Record<string, string[]> = {
  prompt_injection: ['AML.T0051'],
  rag_data_poisoning: ['AML.T0070'],
  agent_tool_abuse: ['AML.T0053'],
  system_prompt_leakage: ['AML.T0056'],
  training_data_extraction: ['AML.T0024.000'],
  data_exfiltration: ['AML.T0086'],
  model_denial_of_service: ['AML.T0029'],
};

for (const ids of Object.values(RISK_DOMAIN_ATLAS_TECHNIQUES)) {
  for (const id of ids) {
    if (!ATLAS_TECHNIQUE_IDS.has(id)) throw new Error(`Unknown ATLAS technique ${id}`);
  }
}

export function atlasTechniquesForRiskDomain(domain: string): string[] {
  return RISK_DOMAIN_ATLAS_TECHNIQUES[domain] ?? [];
}
