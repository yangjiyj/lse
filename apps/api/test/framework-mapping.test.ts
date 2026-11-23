import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RISK_DOMAIN } from '@lse/shared';
import { atlasTechniquesForRiskDomain, ATLAS_TECHNIQUE_IDS } from '../src/modules/frameworks/index.js';

test('风险域技术映射仅引用固定版 ATLAS 中真实存在的技术 ID', () => {
  const mapped: string[] = [];
  for (const domain of RISK_DOMAIN) {
    for (const id of atlasTechniquesForRiskDomain(domain)) {
      assert.ok(ATLAS_TECHNIQUE_IDS.has(id), `${domain} 引用了不存在的技术 ${id}`);
      mapped.push(domain);
    }
  }
  assert.deepEqual(mapped.sort(), [
    'agent_tool_abuse',
    'data_exfiltration',
    'model_denial_of_service',
    'prompt_injection',
    'rag_data_poisoning',
    'system_prompt_leakage',
    'training_data_extraction',
  ]);
  assert.deepEqual(atlasTechniquesForRiskDomain('general_safety'), []);
});
