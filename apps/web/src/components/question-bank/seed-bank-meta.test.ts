import { describe, expect, it } from 'vitest';
import {
  SEED_BANK_GROUPS,
  gbtBankRequirement,
  isLargeBank,
  runSourceType,
  seedBankCoverage,
  seedBankGroup,
  seedBankMeta,
} from './seed-bank-meta';

describe('seedBankGroup：种子库按用途分三组', () => {
  it('组名与顺序', () => {
    expect(SEED_BANK_GROUPS.map((g) => g.title)).toEqual([
      '国标合规检测题库',
      '对抗演练种子',
      '可选题源',
    ]);
  });
  it('builtin:gbt45654 开头的归国标合规检测题库', () => {
    for (const s of [
      'builtin:gbt45654:generation',
      'builtin:gbt45654:refusal',
      'builtin:gbt45654:non-refusal',
    ]) {
      expect(seedBankGroup(s)).toBe('gbt');
    }
  });
  it('builtin:red-team 开头的归对抗演练种子', () => {
    for (const s of ['builtin:red-team', 'builtin:red-team:standard', 'builtin:red-team:deep']) {
      expect(seedBankGroup(s)).toBe('red-team');
    }
  });
  it('其余和认不出的来源一律归可选题源', () => {
    for (const s of [
      'builtin:dataset:safety-prompts',
      'builtin:compliance:tc260',
      'builtin:mcp:attacks',
      'benchmark:lse-safety-mini',
      'builtin:gbt',
      'gbt45654:generation',
      'xyz',
      '',
      null,
      undefined,
    ]) {
      expect(seedBankGroup(s)).toBe('optional');
    }
  });
  it('国标三个题库的规模要求：生成内容 2000，应拒答、非拒答各 500；其他没有', () => {
    expect(gbtBankRequirement('builtin:gbt45654:generation')).toBe(2000);
    expect(gbtBankRequirement('builtin:gbt45654:refusal')).toBe(500);
    expect(gbtBankRequirement('builtin:gbt45654:non-refusal')).toBe(500);
    expect(gbtBankRequirement('builtin:compliance:tc260')).toBeNull();
    expect(gbtBankRequirement(null)).toBeNull();
  });
});

describe('seed-bank-meta', () => {
  it('Safety-Prompts 标注清华 CoAI 与 Apache-2.0', () => {
    const m = seedBankMeta('builtin:dataset:safety-prompts');
    expect(m.provenance).toContain('CoAI');
    expect(m.provenance).toContain('Apache-2.0');
  });
  it('未知来源不编造许可，写「内置」', () => {
    expect(seedBankMeta('builtin:unknown:x').provenance).toContain('许可：内置');
    expect(seedBankMeta(null).provenance).toContain('许可：内置');
  });
  it('MCP / 红队 / 基准按前缀匹配', () => {
    expect(seedBankMeta('builtin:mcp:abc').purpose).toContain('MCP');
    expect(seedBankMeta('builtin:red-team:deep').provenance).toContain('红队');
    expect(seedBankMeta('benchmark:s1').provenance).toContain('基准');
  });
  it('超过 10000 题视为大库', () => {
    expect(isLargeBank(99798)).toBe(true);
    expect(isLargeBank(10000)).toBe(false);
  });
  it('基准样例的来源文案不再出现旧名 LSE', () => {
    expect(seedBankMeta('benchmark:lse-safety-mini').provenance).not.toMatch(/LSE/);
  });
  it('TC260 样本库的覆盖风险写实际覆盖的大类，不再只是“通用安全风险”', () => {
    const tags = seedBankCoverage('builtin:compliance:tc260', ['通用安全风险']);
    expect(tags.length).toBeGreaterThanOrEqual(5);
    expect(tags).toContain('违反社会主义核心价值观的内容');
    expect(tags).toContain('歧视性内容');
    expect(tags).not.toContain('通用安全风险');
    // 大类名不带“A.1 ”编号前缀
    expect(tags.every((t) => !/^A\.\d/.test(t))).toBe(true);
  });
  it('后端已给出具体覆盖风险时保持原样；取不到时展示“覆盖多类风险”', () => {
    expect(seedBankCoverage('builtin:other', ['内容安全', '提示注入'])).toEqual([
      '内容安全',
      '提示注入',
    ]);
    expect(seedBankCoverage('builtin:other', ['通用安全风险'])).toEqual(['覆盖多类风险']);
    expect(seedBankCoverage('builtin:other', [])).toEqual(['覆盖多类风险']);
    expect(seedBankCoverage(null, undefined)).toEqual(['覆盖多类风险']);
  });
  it('运行记录来源类型归类', () => {
    expect(runSourceType('comprehensive:t1:x').id).toBe('comprehensive');
    expect(runSourceType('red-team-import').id).toBe('red-team');
    expect(runSourceType(null).label).toBe('验收 / 发布验证');
  });
});
