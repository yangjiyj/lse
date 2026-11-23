import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import atlas from '../src/modules/frameworks/data/atlas-v2026.09.json' with { type: 'json' };
import owasp from '../src/modules/frameworks/data/owasp.json' with { type: 'json' };
import { atlasTechniquesForRiskDomain, ATLAS_TECHNIQUE_IDS } from '../src/modules/frameworks/index.js';

test('固定版 ATLAS 数据含技术编号与战术关系', () => {
  const matrix = atlas.matrices[0];
  const ids = new Set(matrix.techniques.map((item) => item.id));
  assert.ok(ids.has('AML.T0000'));
  for (const domain of ['prompt_injection', 'rag_data_poisoning', 'agent_tool_abuse', 'system_prompt_leakage', 'training_data_extraction', 'data_exfiltration', 'model_denial_of_service']) {
    for (const id of atlasTechniquesForRiskDomain(domain)) assert.ok(ATLAS_TECHNIQUE_IDS.has(id), `${domain} 引用了不存在的技术 ${id}`);
  }
  assert.ok(matrix.techniques.every((item) => /^AML\.T\d{4}(?:\.\d{3})?$/.test(item.id)));
  assert.ok(matrix.techniques.filter((item) => item.tactics).every((item) => item.tactics.every((id) => atlas.matrices[0].tactics.some((tactic) => tactic.id === id))));
  const raw = readFileSync(new URL('../src/modules/frameworks/data/ATLAS.yaml', import.meta.url));
  assert.equal(createHash('sha256').update(raw).digest('hex'), 'c9c23971d0db07e2782423d795a20e78d5c2c9bcdc78fc67e24530657daaec41');
});

test('OWASP 官方条目编号、英文原名和平台译名齐全', () => {
  assert.equal(owasp.llm.items.length, 10);
  assert.equal(owasp.agentic.items.length, 10);
  assert.equal(owasp.llm.items[0].nameEn, 'Prompt Injection');
  assert.equal(owasp.agentic.items[0].id, 'ASI01');
  for (const item of [...owasp.llm.items, ...owasp.agentic.items]) {
    assert.ok(item.nameEn.length > 0);
    assert.equal(item.translation, '平台译名');
  }
});

test('ATLAS 中文译名只引用存在的编号，且不改动英文原名', async () => {
  const { ATLAS_ZH_DATA } = await import('../src/modules/frameworks/index.js');
  const matrix = atlas.matrices[0];
  const techniqueIds = new Set(matrix.techniques.map((item) => item.id));
  const tacticIds = new Set(matrix.tactics.map((item) => item.id));
  for (const id of Object.keys(ATLAS_ZH_DATA.techniques)) assert.ok(techniqueIds.has(id), id);
  for (const id of Object.keys(ATLAS_ZH_DATA.tactics)) assert.ok(tacticIds.has(id), id);
  assert.equal(Object.keys(ATLAS_ZH_DATA.tactics).length, tacticIds.size);
  assert.equal(matrix.techniques.find((item) => item.id === 'AML.T0051')?.name, 'LLM Prompt Injection');
});
