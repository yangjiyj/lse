import { describe, expect, it } from 'vitest';
import type { EndpointTaskSummary } from '@/lib/api';
import { postureTaskOverview } from './posture-task-overview';

const base: EndpointTaskSummary = {
  mode: 'posture',
  endpoint: { name: '测试终端', lastSeenAt: null },
  agents: [],
  verdictLine: '',
  groups: [],
  liveScenarios: [],
};
const agent = (extra: Record<string, unknown> = {}) => ({
  product: 'claude-code',
  displayName: 'Claude Code',
  version: '2.1.126',
  liveEvalSupported: false,
  liveEvalRegistered: false,
  ...extra,
});
const overviewOf = (agents: unknown[]) =>
  postureTaskOverview({ ...base, agents } as EndpointTaskSummary);

describe('历史任务快照转概览：智能体配置读取状态', () => {
  it('快照里没有配置读取状态时标为“任务未记录”，不当作没读到，也不带说明句', () => {
    const row = overviewOf([agent()]).agents[0]!;
    expect(row.configState).toBe('unrecorded');
    expect(row.configItems).toEqual([]);
    expect(row.configNote).toBeNull();
    expect(JSON.stringify(row)).not.toContain('历史任务未记录配置读取状态');
    expect(row.configState).not.toBe('not_checked');
  });

  it.each(['checked', 'default', 'partial', 'internal_store', 'read_failed', 'not_checked'] as const)(
    '快照记录了配置读取状态 %s 时如实带出，包括分项与说明',
    (state) => {
      const items = [
        { item: 'permission' as const, state: 'internal_store' as const, installs: 1 },
        { item: 'sandbox' as const, state: 'explicit' as const, installs: 1 },
      ];
      const row = overviewOf([agent({ config: { state, items, note: '一句说明' } })]).agents[0]!;
      expect(row.configState).toBe(state);
      expect(row.configItems).toEqual(items);
      expect(row.configNote).toBe('一句说明');
    },
  );

  it('安装位置与账号原样带出，没有时为空，不同安装各自一行', () => {
    const agents = overviewOf([
      agent({ location: '~/.claude', account: 'yj' }),
      agent({ location: '…/package.json 所在目录', account: 'alice' }),
      agent({ product: 'codex', displayName: 'Codex' }),
    ]).agents;
    expect(agents.map((a) => [a.key, a.location ?? null, a.account ?? null])).toEqual([
      ['claude-code', '~/.claude', 'yj'],
      ['claude-code', '…/package.json 所在目录', 'alice'],
      ['codex', null, null],
    ]);
  });
});


describe('历史任务快照转概览：风险行的标题与依据', () => {
  const reasons = ['缺依赖检查结果。', '缺工具描述。', '缺启动命令。'];
  const finding = (o: Record<string, unknown>) => ({ compliance: [], riskCategory: 'x', evidence: '', ...o });
  const build = (items: unknown[]) =>
    postureTaskOverview({
      ...base,
      groups: [{ id: 'g', label: '权限', items }],
    } as unknown as EndpointTaskSummary);

  it('没检查的行：标题写一句话，原因多条时依据只给第一条再加“等 N 项”，不把全部原因拼成一段', () => {
    const o = build([
      finding({
        ruleId: 'mcp_server', plainTitle: 'MCP 工具安全', severity: 'MEDIUM', verdict: 'UNKNOWN', state: 'not_checked',
        notCheckedReason: reasons.join('；'), howToCheck: '更新探针后重新检测。',
        subjects: reasons.map((r, i) => ({ kind: 'mcp', name: `工具 ${i}`, state: 'not_checked', detail: r })),
      }),
    ]);
    const row = o.risks[0]!;
    expect(row.level).toBe('NOT_CHECKED');
    expect(row.title).toBe('MCP 工具安全没有检查');
    expect(row.basis).toBe('缺依赖检查结果。等 3 项原因');
    expect(row.basis).not.toContain('；');
    expect(row.title).not.toBe(row.basis);
  });

  it('没检查的行只有一条原因时，依据就是这条原因；标题与依据不再是同一句话', () => {
    const o = build([
      finding({
        ruleId: 'skill_risk', plainTitle: 'Skill 技能风险', severity: 'MEDIUM', verdict: 'UNKNOWN', state: 'not_checked',
        notCheckedReason: '终端没有提供检查信息',
        subjects: [{ kind: 'skill', name: '技能 1', state: 'not_checked', detail: '终端没有提供检查信息' }],
      }),
    ]);
    const row = o.risks[0]!;
    expect(row.title).toBe('Skill 技能风险没有检查');
    expect(row.basis).toBe('终端没有提供检查信息');
  });

  it('有风险的行：依据只列一句对象说明，完整逐对象说明在抽屉的涉及对象里', () => {
    const names = ['Claude Code 2.1.308', 'Hermes', 'OpenCode'];
    const text = '该智能体配置了绕过权限确认或自动批准。请关闭跳过确认的设置。';
    const o = build([
      finding({
        ruleId: 'permissions', plainTitle: '权限确认边界', severity: 'HIGH', verdict: 'FAIL', state: 'risk',
        evidence: names.map((n) => `${n}：${text}`).join('；'),
        subjects: names.map((n) => ({ kind: 'agent', name: n, state: 'risk', detail: text })),
      }),
    ]);
    const row = o.risks[0]!;
    // 对象数已在“涉及”列显示，依据里不再重复，也就不会被截断吞掉
    expect(row.involved).toBe('3 个对象');
    expect(row.basis).toBe(text);
    expect(row.basis).not.toContain('；');
    expect(row.subjects.map((s) => s.name)).toEqual(names);
  });

  it('有风险的行只有一个对象时，依据就是这个对象的说明', () => {
    const o = build([
      finding({
        ruleId: 'credentials', plainTitle: '凭据暴露', severity: 'MEDIUM', verdict: 'FAIL', state: 'risk',
        evidence: 'Claude Code：存在凭据暴露。',
        subjects: [{ kind: 'agent', name: 'Claude Code', state: 'risk', detail: '存在凭据暴露。' }],
      }),
    ]);
    expect(o.risks[0]!.basis).toBe('存在凭据暴露。');
  });

  it('没有对象明细的旧快照仍沿用原证据文字，不丢信息', () => {
    const o = build([
      finding({ ruleId: 'x', plainTitle: '某项', severity: 'LOW', verdict: 'FAIL', state: 'risk', evidence: '原证据文字', subjects: [] }),
    ]);
    expect(o.risks[0]!.basis).toBe('原证据文字');
  });
});

describe('历史任务快照转概览：风险类别', () => {
  const finding = (o: Record<string, unknown>) => ({ compliance: [], riskCategory: 'x', evidence: '', ...o });
  const categoryOf = (ruleId: string, state: 'risk' | 'not_checked') =>
    postureTaskOverview({
      ...base,
      groups: [
        {
          id: 'g',
          label: '组',
          items: [
            finding({
              ruleId, plainTitle: '某项', severity: 'HIGH', verdict: state === 'risk' ? 'FAIL' : 'UNKNOWN', state,
              notCheckedReason: '终端没有提供检查信息', evidence: '证据',
              subjects: [{ kind: 'agent', name: 'a', state, detail: '说明' }],
            }),
          ],
        },
      ],
    } as unknown as EndpointTaskSummary).risks[0]!.category;

  it.each([
    ['permissions', 'permission'],
    ['credentials', 'credential'],
    ['mcp_server', 'mcp'],
    ['skill_risk', 'skill'],
    ['instruction_files', 'permission'],
  ])('真实风险 %s 的类别是 %s，不写成“检查覆盖”', (ruleId, expected) => {
    expect(categoryOf(ruleId, 'risk')).toBe(expected);
  });

  it('没检查的行类别才是“检查覆盖”', () => {
    expect(categoryOf('mcp_server', 'not_checked')).toBe('coverage');
    expect(categoryOf('permissions', 'not_checked')).toBe('coverage');
  });

  it('没检查但没有对象明细时，依据保留完整原因，不截成“等 N 项”', () => {
    const o = postureTaskOverview({
      ...base,
      groups: [
        {
          id: 'g',
          label: '组',
          items: [
            {
              compliance: [], riskCategory: 'x', evidence: '', ruleId: 'mcp_server', plainTitle: 'MCP 工具安全',
              severity: 'MEDIUM', verdict: 'UNKNOWN', state: 'not_checked',
              notCheckedReason: '缺依赖结果。；缺工具描述。', subjects: [],
            },
          ],
        },
      ],
    } as unknown as EndpointTaskSummary);
    expect(o.risks[0]!.basis).toBe('缺依赖结果。；缺工具描述。');
  });
});


describe('历史任务快照转概览：没检查按成因词表归类', () => {
  const finding = (o: Record<string, unknown>) => ({
    compliance: [],
    riskCategory: 'x',
    evidence: '',
    ...o,
  });
  const notChecked = (ruleId: string, subjects: unknown[], extra: Record<string, unknown> = {}) =>
    finding({
      ruleId,
      plainTitle: '某项检查',
      severity: 'MEDIUM',
      verdict: 'UNKNOWN',
      state: 'not_checked',
      notCheckedReason: '整句原因',
      howToCheck: '整句办法',
      subjects,
      ...extra,
    });
  const build = (items: unknown[], agents: unknown[] = []) =>
    postureTaskOverview({
      ...base,
      agents,
      groups: [{ id: 'g', label: '组', items }],
    } as unknown as EndpointTaskSummary);
  const sub = (kind: string, name: string, cause?: string, where?: string) => ({
    kind,
    name,
    state: 'not_checked',
    detail: '整句原因',
    ...(cause ? { cause } : {}),
    ...(where ? { where } : {}),
  });

  it('带成因键的对象按“处理方 × 领域”合并成行，每一类的原因与办法取自词表，不再沿用整句原因', () => {
    const o = build([
      notChecked('skill_risk', [
        sub('skill', '技能 1', 'skill_scan_partial'),
        sub('skill', '技能 2', 'skill_scan_partial'),
      ]),
      notChecked('permissions', [
        sub('agent', 'Codex 0.160.1', 'config_read_failed', 'yj · ~/.codex'),
      ]),
    ]);
    const rows = o.risks.filter((r) => r.level === 'NOT_CHECKED');
    expect(rows.map((r) => [r.owner, r.category])).toEqual([
      ['admin', 'agent'],
      ['probe', 'skill'],
    ]);
    expect(rows[0]!.groups?.[0]?.subjects).toEqual([
      { name: 'Codex 0.160.1', detail: 'yj · ~/.codex' },
    ]);
    expect(rows[1]!.involved).toBe('2 个技能');
    expect(rows.map((r) => r.basis).join('')).not.toContain('整句原因');
    // 带成因键的对象全部归入分组后，原来按整句原因合并的那一行不再出现
    expect(o.risks.filter((r) => r.id.startsWith('没检查-'))).toHaveLength(0);
  });

  it('技能列表带出成因，同一技能有多个成因时取最先该说的', () => {
    const o = build([
      notChecked('skill_risk', [sub('skill', '技能 1', 'skill_rules_missing')]),
      notChecked('skill_risk_2', [sub('skill', '技能 1', 'skill_scan_partial')]),
    ]);
    expect(o.skills.find((s) => s.name === '技能 1')?.cause).toBe('skill_scan_partial');
  });

  it('旧任务的对象没有成因键：沿用整句原因的行，不被丢掉，也不混进分组行', () => {
    const o = build([notChecked('skill_risk', [sub('skill', '技能 1')])]);
    const rows = o.risks.filter((r) => r.level === 'NOT_CHECKED');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.owner).toBeUndefined();
    expect(rows[0]!.groups).toBeUndefined();
    expect(rows[0]!.basis).toBe('整句原因');
    expect(rows[0]!.advice).toBe('整句办法');
    expect(o.skills[0]!.cause).toBeUndefined();
  });

  it('新旧对象混在同一项检查里：有成因的进分组，没有成因的留在整句原因行', () => {
    const o = build([
      notChecked('skill_risk', [
        sub('skill', '新技能', 'skill_scan_partial'),
        sub('skill', '旧技能'),
      ]),
    ]);
    const rows = o.risks.filter((r) => r.level === 'NOT_CHECKED');
    expect(rows).toHaveLength(2);
    expect(
      rows.some(
        (r) => r.id.startsWith('没检查-') && r.subjects.map((s) => s.name).join() === '旧技能',
      ),
    ).toBe(true);
    expect(rows.some((r) => r.owner === 'probe' && r.involved === '1 个技能')).toBe(true);
  });

  it('有风险的行排在没检查之前，计数按新行重算并给出管理员能处理的行数', () => {
    const o = build([
      finding({
        ruleId: 'permissions',
        plainTitle: '权限确认边界',
        severity: 'HIGH',
        verdict: 'FAIL',
        state: 'risk',
        subjects: [{ kind: 'agent', name: 'Claude Code', state: 'risk', detail: '说明' }],
      }),
      notChecked('permissions', [sub('agent', 'Codex', 'config_read_failed', 'yj')]),
      notChecked('skill_risk', [sub('skill', '技能 1', 'skill_scan_partial')]),
    ]);
    expect(o.risks.map((r) => r.level)).toEqual(['HIGH', 'NOT_CHECKED', 'NOT_CHECKED']);
    expect(o.counts.openRisks).toBe(1);
    expect(o.counts.highRisks).toBe(1);
    expect(o.counts.notCheckedKinds).toBe(2);
    expect(o.counts.notCheckedAdmin).toBe(1);
    expect(o.counts.notCheckedInstalls).toBe(2);
  });

  it('大样本：200 个技能同一成因，只出一行，行内对象最多 50 个，其余只给数量', () => {
    const subjects = Array.from({ length: 200 }, (_, i) =>
      sub('skill', `技能 ${i + 1}`, 'skill_scan_partial'),
    );
    const o = build([notChecked('skill_risk', subjects)]);
    const rows = o.risks.filter((r) => r.level === 'NOT_CHECKED');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subjectCount).toBe(200);
    expect(rows[0]!.subjects).toHaveLength(50);
    expect(rows[0]!.moreCount).toBe(150);
    expect(o.skills).toHaveLength(200);
  });

  it('智能体安装序号不进对象名；同名不同账号的安装不被去重成一个', () => {
    const o = build([
      notChecked('permissions', [
        sub('agent', 'Claude Code 2.1.126（安装项 1）', 'config_unknown', 'root · ~/.claude'),
        sub('agent', 'Claude Code 2.1.126（安装项 2）', 'config_unknown', 'alice · ~/.claude'),
      ]),
    ]);
    const row = o.risks.find((r) => r.level === 'NOT_CHECKED')!;
    expect(row.subjects.map((s) => s.name)).toEqual(['Claude Code 2.1.126', 'Claude Code 2.1.126']);
    expect(row.subjects.map((s) => s.detail)).toEqual(['root · ~/.claude', 'alice · ~/.claude']);
  });
});

describe('历史任务快照转概览：对象按各自状态分流，不在风险行或没检查行里混入无关对象', () => {
  const finding = (o: Record<string, unknown>) => ({
    compliance: [],
    riskCategory: 'x',
    evidence: '',
    plainTitle: '某项检查',
    severity: 'MEDIUM',
    ...o,
  });
  const build = (items: unknown[]) =>
    postureTaskOverview({
      ...base,
      groups: [{ id: 'g', label: '外部工具安全', items }],
    } as unknown as EndpointTaskSummary);
  const sub = (kind: string, name: string, state: string, extra: Record<string, unknown> = {}) => ({
    kind,
    name,
    state,
    detail: state === 'clear' ? '已检查，未发现此项风险。' : '说明',
    ...extra,
  });

  it('风险行只列有风险的对象：已检查无风险的和没检查的不算在“涉及对象”里', () => {
    const o = build([
      finding({
        ruleId: 'permissions',
        plainTitle: '权限确认边界',
        severity: 'HIGH',
        verdict: 'FAIL',
        state: 'risk',
        subjects: [
          sub('agent', 'Claude Code 2.1.126（安装项 1）', 'clear'),
          sub('agent', 'Claude Code 2.1.308（安装项 2）', 'risk', { detail: '风险说明' }),
          sub('agent', 'Hermes（安装项 4）', 'risk', { detail: '风险说明' }),
          sub('agent', 'Codex 0.160.1（安装项 3）', 'not_checked', {
            cause: 'config_read_failed',
            where: 'yj',
          }),
        ],
      }),
    ]);
    const row = o.risks.find((r) => r.id === 'permissions')!;
    expect(row.involved).toBe('2 个对象');
    expect(row.subjects.map((s) => s.name)).toEqual([
      'Claude Code 2.1.308（安装项 2）',
      'Hermes（安装项 4）',
    ]);
    expect(o.counts.openRisks).toBe(1);
    // 没检查的那一个仍然按成因出现在没检查的行里
    expect(o.risks.some((r) => r.level === 'NOT_CHECKED' && r.owner === 'admin')).toBe(true);
  });

  it('没检查的检查项里夹着已检查无风险的对象：它们不进没检查行，没检查的对象只出现一次', () => {
    const o = build([
      finding({
        ruleId: 'mcp_risk',
        plainTitle: 'MCP 配置风险',
        verdict: 'UNKNOWN',
        state: 'not_checked',
        notCheckedReason: '拼起来的整句原因',
        subjects: [
          sub('mcp', 'ppt', 'clear'),
          sub('mcp', 'ppt', 'clear'),
          sub('mcp', 'ppt', 'not_checked', { cause: 'mcp_dependency_unknown' }),
          sub('mcp', 'ppt', 'not_checked', { cause: 'mcp_launch_unverified' }),
        ],
      }),
    ]);
    const rows = o.risks.filter((r) => r.level === 'NOT_CHECKED');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.owner).toBe('manual');
    expect(rows[0]!.groups?.map((g) => g.cause)).toEqual([
      'mcp_dependency_unknown',
      'mcp_launch_unverified',
    ]);
    expect(JSON.stringify(rows)).not.toContain('已检查，未发现此项风险');
    expect(JSON.stringify(rows)).not.toContain('拼起来的整句原因');
  });

  it('“待确认”的检查项生成待确认行，技能列表是待确认并带命中位置，不写成“没有检查”', () => {
    const hit = {
      rule_id: 'skill.credential_access',
      reason_zh: '会读取凭据',
      file_label: 'SKILL.md',
      line_number: 78,
      context_type: 'code_block',
    };
    const o = build([
      finding({
        ruleId: 'skill_risk',
        plainTitle: '技能高危行为',
        severity: 'HIGH',
        verdict: 'UNKNOWN',
        state: 'review',
        subjects: [
          sub('skill', '技能 A', 'review', { ...hit, hits: [hit] }),
          sub('skill', '技能 B', 'clear'),
          sub('skill', '技能 C', 'not_checked', { cause: 'skill_scan_partial' }),
        ],
      }),
    ]);
    const review = o.risks.find((r) => r.level === 'REVIEW')!;
    expect(review.title).toBe('技能文档命中需要人工确认');
    expect(review.involved).toBe('1 个对象');
    // 待确认的说明对谁都一样，抽屉里不在每个对象下重复，只列名称
    expect(review.subjects).toEqual([{ name: '技能 A', detail: '' }]);
    expect(o.counts.reviewItems).toBe(1);
    expect(o.counts.openRisks).toBe(0);
    // 没有任何“技能高危行为没有检查”这样的行：已检查无风险的技能不该被写成没检查
    expect(o.risks.some((r) => r.title.includes('没有检查'))).toBe(false);
    const skill = (name: string) => o.skills.find((s) => s.name === name)!;
    expect(skill('技能 A').state).toBe('review');
    expect(skill('技能 A').hits).toEqual([
      {
        rule: 'skill.credential_access',
        // 说明取自与终端页共用的受控词表，不回显探针原文
        label: '命中凭据读取规则',
        file: 'SKILL.md',
        line: 78,
        contextType: 'code_block',
      },
    ]);
    expect(skill('技能 B').state).toBe('clear');
    expect(skill('技能 C').state).toBe('not_checked');
    expect(skill('技能 C').cause).toBe('skill_scan_partial');
  });

  it('历史任务当时没有这项检查结果：不列对象，同一原因的几项检查合成一行，行内列检查项名称', () => {
    const reason = '终端尚未返回这项检查的有效结论。';
    const o = build([
      finding({
        ruleId: 'mcp_transport',
        plainTitle: '工具连接与外联范围',
        verdict: 'UNKNOWN',
        state: 'not_checked',
        notCheckedReason: reason,
        howToCheck: '重新检测',
        subjects: [sub('mcp', 'ppt', 'clear')],
      }),
      finding({
        ruleId: 'skill_source',
        plainTitle: '技能来源可追溯性',
        verdict: 'UNKNOWN',
        state: 'not_checked',
        notCheckedReason: reason,
        howToCheck: '重新检测',
        subjects: Array.from({ length: 87 }, (_, i) => sub('skill', `技能 ${i}`, 'clear')),
      }),
    ]);
    const rows = o.risks.filter((r) => r.level === 'NOT_CHECKED');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.involved).toBe('2 项检查');
    expect(rows[0]!.title).toBe('工具连接与外联范围等 2 项没有检查');
    expect(rows[0]!.basis).toBe(reason);
    expect(rows[0]!.subjects.map((s) => s.name)).toEqual([
      '工具连接与外联范围',
      '技能来源可追溯性',
    ]);
    expect(JSON.stringify(rows)).not.toContain('已检查，未发现此项风险');
    expect(JSON.stringify(rows)).not.toContain('0 个对象');
  });

  it('风险检查项里没有成因键的没检查对象（旧快照）不丢：进整句原因行', () => {
    const o = build([
      finding({
        ruleId: 'credentials',
        plainTitle: '凭据暴露',
        verdict: 'FAIL',
        state: 'risk',
        subjects: [
          sub('agent', 'A', 'risk', { detail: '风险说明' }),
          sub('agent', 'B', 'not_checked', { detail: '旧快照里的整句原因' }),
        ],
      }),
    ]);
    const legacy = o.risks.filter((r) => r.level === 'NOT_CHECKED');
    expect(legacy).toHaveLength(1);
    expect(legacy[0]!.subjects.map((s) => s.name)).toEqual(['B']);
    expect(legacy[0]!.basis).toBe('旧快照里的整句原因');
    expect(o.risks.find((r) => r.id === 'credentials')!.subjects.map((s) => s.name)).toEqual(['A']);
  });

  it('技能命中只留文件名不带终端路径；脚本文件判为脚本，不认识的规则用统一说明；同一命中不重复', () => {
    const script = {
      rule_id: 'skill.pipe_shell',
      file_label: '/Users/alice/.claude/skills/x/scripts/run.sh',
      line_number: 3,
    };
    const unknownRule = { rule_id: 'skill.something_new', file_label: 'notes.txt' };
    const o = build([
      finding({
        ruleId: 'skill_risk',
        plainTitle: '技能高危行为',
        severity: 'HIGH',
        verdict: 'FAIL',
        state: 'risk',
        subjects: [
          sub('skill', '技能 X', 'risk', { ...script, hits: [script, script, unknownRule] }),
        ],
      }),
    ]);
    const hits = o.skills.find((s) => s.name === '技能 X')!.hits;
    expect(hits).toEqual([
      {
        rule: 'skill.pipe_shell',
        label: '命中下载并运行规则',
        file: 'run.sh',
        line: 3,
        contextType: 'script',
      },
      {
        rule: 'skill.something_new',
        label: '命中技能检查规则',
        file: 'notes.txt',
        line: null,
        contextType: 'unknown',
      },
    ]);
    expect(JSON.stringify(o)).not.toContain('/Users/alice');
  });

  it('风险行按等级排序：高危在前，待确认在风险之后、没检查之前', () => {
    const o = build([
      finding({
        ruleId: 'a',
        plainTitle: 'A',
        severity: 'MEDIUM',
        verdict: 'FAIL',
        state: 'risk',
        subjects: [sub('agent', 'x', 'risk')],
      }),
      finding({
        ruleId: 'b',
        plainTitle: 'B',
        severity: 'HIGH',
        verdict: 'FAIL',
        state: 'risk',
        subjects: [sub('agent', 'y', 'risk')],
      }),
      finding({
        ruleId: 'skill_risk',
        plainTitle: 'C',
        severity: 'HIGH',
        verdict: 'UNKNOWN',
        state: 'review',
        subjects: [sub('skill', 's', 'review')],
      }),
      finding({
        ruleId: 'd',
        plainTitle: 'D',
        verdict: 'UNKNOWN',
        state: 'not_checked',
        notCheckedReason: '原因',
        subjects: [],
      }),
    ]);
    expect(o.risks.map((r) => r.level)).toEqual(['HIGH', 'MEDIUM', 'REVIEW', 'NOT_CHECKED']);
  });
});

describe('新版指令检查快照', () => {
  it('智能体对象按各自状态分流，防护风险单独一行，补查数量以安装计', () => {
    const o = postureTaskOverview({
      ...base,
      groups: [
        {
          id: 'g',
          label: '配置',
          items: [
            {
              ruleId: 'hooks',
              plainTitle: '防护接入',
              severity: 'MEDIUM',
              verdict: 'FAIL',
              state: 'risk',
              subjects: [
                {
                  kind: 'agent',
                  name: 'Claude Code',
                  state: 'risk',
                  detail: '该智能体没有接入所需的终端工具防护。',
                },
              ],
            },
            {
              ruleId: 'instruction_file',
              plainTitle: '指令文件',
              severity: 'HIGH',
              verdict: 'FAIL',
              state: 'risk',
              subjects: [
                {
                  kind: 'agent',
                  name: '已查完',
                  state: 'clear',
                  detail: '已检查 3 个指令文件，未发现隐藏字符、密钥或可疑指令。',
                },
                {
                  kind: 'agent',
                  name: '未查完',
                  state: 'not_checked',
                  cause: 'instruction_scan_incomplete',
                  detail: '未完成',
                },
                {
                  kind: 'agent',
                  name: '有风险',
                  state: 'risk',
                  detail: '指令文件含疑似密钥。',
                  where: 'CLAUDE.md · 用户级',
                },
              ],
            },
          ],
        },
      ],
    } as unknown as EndpointTaskSummary);
    expect(o.risks.filter((r) => r.id === 'hooks')).toHaveLength(1);
    expect(o.risks.find((r) => r.id === 'instruction_file')!.subjects.map((s) => s.name)).toEqual([
      '有风险',
    ]);
    const incomplete = o.risks.find((r) =>
      r.groups?.some((g) => g.cause === 'instruction_scan_incomplete'),
    )!;
    expect(incomplete.owner).toBe('probe');
    expect(incomplete.involved).toBe('1 处安装');
    expect(incomplete.subjects.map((s) => s.name)).toEqual(['未查完']);
    expect(JSON.stringify(o.risks)).not.toContain('已查完');
  });
});
