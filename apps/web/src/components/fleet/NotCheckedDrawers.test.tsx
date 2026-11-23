import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type {
  EndpointOverview,
  EndpointRiskRow,
  EndpointSkillRow,
} from '../../../../../packages/shared/src/endpoint-overview';
import {
  NOT_CHECKED_CAUSES,
  buildNotCheckedRows,
  type NotCheckedEntry,
} from '../../../../../packages/shared/src/not-checked';
import { EndpointOverviewLists } from './EndpointOverviewLists';
import { overviewFixture } from './endpoint-overview.test-data';

const empty: EndpointOverview = {
  ...overviewFixture,
  risks: [],
  agents: [],
  skills: [],
  mcp: [],
  platforms: [],
  history: [],
  counts: { ...overviewFixture.counts, notCheckedKinds: 0, notCheckedInstalls: 0 },
};

function show(overview: EndpointOverview, showCounts = false) {
  return render(
    <MemoryRouter>
      <EndpointOverviewLists overview={overview} showCounts={showCounts} />
    </MemoryRouter>,
  );
}

const entry = (cause: string, name: string, detail = ''): NotCheckedEntry => ({
  cause,
  name,
  detail,
});
const rowsOf = (entries: NotCheckedEntry[]): EndpointRiskRow[] => buildNotCheckedRows(entries);
const withRisks = (risks: EndpointRiskRow[]): EndpointOverview => ({
  ...empty,
  risks,
  counts: {
    ...empty.counts,
    notCheckedKinds: risks.length,
    notCheckedInstalls: risks.reduce((n, r) => n + r.subjectCount, 0),
    notCheckedAdmin: risks.filter((r) => r.owner === 'admin').length,
  },
});

describe('没检查的风险行：处理方、成因分组、旧响应', () => {
  it('状态列写处理方而不是笼统的“没检查”，管理员能处理的排在最前', () => {
    const rows = rowsOf([
      entry('skill_scan_partial', '技能 A'),
      entry('mcp_launch_unverified', 'MCP A'),
      entry('config_read_failed', 'Codex 0.160.1', 'yj'),
    ]);
    show(withRisks(rows));
    const table = screen.getByRole('table');
    const body = within(table).getAllByRole('row').slice(1);
    expect(body[0]).toHaveTextContent('需管理员处理');
    expect(body[1]).toHaveTextContent('需人工核对');
    expect(body[2]).toHaveTextContent('暂时查不了');
    expect(within(table).queryByText('没检查', { selector: 'td' })).not.toBeInTheDocument();
  });

  it('管理员能动手的行数显示在“没检查”卡片上，没有时写无需管理员处理', () => {
    const { unmount } = show(
      withRisks(
        rowsOf([entry('config_read_failed', 'Codex', 'yj'), entry('skill_scan_partial', 'a')]),
      ),
      true,
    );
    expect(screen.getByRole('button', { name: /没检查/ })).toHaveTextContent('1 类需管理员处理');
    unmount();
    show(withRisks(rowsOf([entry('skill_scan_partial', 'a')])), true);
    expect(screen.getByRole('button', { name: /没检查/ })).toHaveTextContent('无需管理员处理');
  });

  it('旧响应没有处理方统计时，卡片退回原来的安装数，不报错', () => {
    const { notCheckedAdmin: _, ...counts } = withRisks(
      rowsOf([entry('skill_scan_partial', 'a')]),
    ).counts;
    show({ ...withRisks(rowsOf([entry('skill_scan_partial', 'a')])), counts }, true);
    expect(screen.getByRole('button', { name: /没检查/ })).toHaveTextContent('处安装');
  });

  it('合并行点开后逐类说明原因和办法，每一类各出现一次，标题下写处理方', async () => {
    const rows = rowsOf([
      entry('config_unknown', 'Ollama', 'root'),
      entry('hooks_not_reported', 'Claude Code'),
      entry('broad_allow_not_reported', 'Claude Code'),
      entry('credential_no_files', 'Ollama', 'root'),
    ]);
    expect(rows).toHaveLength(1);
    show(withRisks(rows));
    await userEvent.click(screen.getByRole('button', { name: rows[0]!.title }));
    const drawer = screen.getByRole('dialog');
    for (const key of [
      'config_unknown',
      'hooks_not_reported',
      'broad_allow_not_reported',
      'credential_no_files',
    ] as const) {
      const cause = NOT_CHECKED_CAUSES[key];
      expect(within(drawer).getAllByText(cause.title)).toHaveLength(1);
      expect(within(drawer).getAllByText(cause.basis)).toHaveLength(1);
      expect(within(drawer).getAllByText(cause.advice)).toHaveLength(1);
    }
    expect(within(drawer).getAllByText('办法')).toHaveLength(4);
    expect(within(drawer).getByText('暂时查不了')).toBeInTheDocument();
  });

  it('一律如此的成因只给数量，不逐个列名；会列名的成因带上账号和位置', async () => {
    const rows = rowsOf([
      ...Array.from({ length: 8 }, (_, i) => entry('hooks_not_reported', `Agent ${i}`)),
      entry('config_unknown', 'OpenClaw 2026.9.5', 'yj · ~/.openclaw'),
    ]);
    show(withRisks(rows));
    await userEvent.click(screen.getByRole('button', { name: rows[0]!.title }));
    const drawer = screen.getByRole('dialog');
    expect(drawer).toHaveTextContent('8 处安装');
    expect(drawer).not.toHaveTextContent('Agent 3');
    expect(drawer).toHaveTextContent('OpenClaw 2026.9.5');
    expect(drawer).toHaveTextContent('yj · ~/.openclaw');
  });

  it('单一成因的行：抽屉标题已是这一类，正文只写原因、办法和对象，不再重复标题', async () => {
    const rows = rowsOf([entry('config_read_failed', 'Codex 0.160.1', 'yj')]);
    show(withRisks(rows));
    await userEvent.click(screen.getByRole('button', { name: rows[0]!.title }));
    const drawer = screen.getByRole('dialog');
    expect(within(drawer).getAllByText(rows[0]!.title)).toHaveLength(1);
    expect(within(drawer).getAllByText(NOT_CHECKED_CAUSES.config_read_failed.basis)).toHaveLength(
      1,
    );
    expect(drawer).toHaveTextContent('需管理员处理');
  });

  it('88 个技能同一成因：先列 8 个，其余点开才看；展开后可以收起', async () => {
    const rows = rowsOf(
      Array.from({ length: 88 }, (_, i) => entry('skill_scan_partial', `技能 ${i + 1}`)),
    );
    show(withRisks(rows));
    await userEvent.click(screen.getByRole('button', { name: rows[0]!.title }));
    const drawer = screen.getByRole('dialog');
    expect(within(drawer).getAllByRole('listitem')).toHaveLength(8);
    expect(drawer).not.toHaveTextContent('技能 9');
    // 接口每一类最多回传 50 个对象：8 个先显示，其余 42 个点开，被截掉的 38 个只给数量
    await userEvent.click(within(drawer).getByRole('button', { name: '展开其余 42 个' }));
    expect(within(drawer).getAllByRole('listitem')).toHaveLength(50);
    expect(drawer).toHaveTextContent('另有 38 个');
    await userEvent.click(within(drawer).getByRole('button', { name: '收起' }));
    expect(within(drawer).getAllByRole('listitem')).toHaveLength(8);
  });

  it('旧响应没有分组与处理方：退回“原因 / 办法 / 对象”，对象说明与原因同句时只留名称', async () => {
    const text = '终端没有读取权限；请授权后重新上报';
    const legacy: EndpointRiskRow = {
      id: 'old',
      level: 'NOT_CHECKED',
      category: 'coverage',
      title: '部分配置没检查',
      involved: '3 个对象',
      basis: text,
      advice: '授权后重新上报',
      subjectCount: 3,
      subjects: ['A', 'B', 'C'].map((name) => ({ name, detail: text })),
      moreCount: 0,
    };
    show(withRisks([legacy]));
    expect(within(screen.getByRole('table')).getAllByRole('row')[1]).toHaveTextContent('没检查');
    await userEvent.click(screen.getByRole('button', { name: '部分配置没检查' }));
    const drawer = screen.getByRole('dialog');
    expect(within(drawer).getAllByText(text)).toHaveLength(1);
    expect(drawer).toHaveTextContent('授权后重新上报');
    for (const name of ['A', 'B', 'C']) expect(within(drawer).getByText(name)).toBeInTheDocument();
  });

  it('词表之外的成因键按兜底处理，不出现原始键名', async () => {
    const rows = rowsOf([entry('some_future_cause', '未知对象')]);
    show(withRisks(rows));
    await userEvent.click(screen.getByRole('button', { name: rows[0]!.title }));
    expect(screen.getByRole('dialog')).not.toHaveTextContent('some_future_cause');
    expect(screen.getByRole('dialog')).toHaveTextContent(NOT_CHECKED_CAUSES.check_missing.basis);
  });
});

const skill = (i: number, patch: Partial<EndpointSkillRow> = {}): EndpointSkillRow => ({
  name: `技能 ${String(i).padStart(3, '0')}`,
  sourceLabel: '本地目录',
  sourceState: 'known',
  installedIn: ['Claude Code'],
  installs: 1,
  state: 'clear',
  hits: [],
  ...patch,
});

describe('技能：列表徽标写具体原因，抽屉不让人做做不到的事', () => {
  it('没检查的技能按成因显示徽标，不再整页重复同一句“终端没检查”', async () => {
    const causes = [
      'skill_scan_partial',
      'skill_rules_missing',
      'skill_no_result',
      'skill_source_missing',
    ];
    const skills = Array.from({ length: 200 }, (_, i) =>
      i % 3 === 0 ? skill(i, { state: 'not_checked', cause: causes[i % causes.length] }) : skill(i),
    );
    show({ ...empty, skills, counts: { ...empty.counts, skills: 200 } });
    await userEvent.click(screen.getByRole('tab', { name: 'Skill 200' }));
    const table = screen.getByRole('table');
    expect(within(table).queryByText('终端没检查')).not.toBeInTheDocument();
    expect(within(table).getAllByRole('row')).toHaveLength(21);
    await userEvent.selectOptions(screen.getByLabelText('筛选状态'), 'not_checked');
    const badges = new Set(
      [...table.querySelectorAll('tbody td:nth-child(4) span')].map((n) => n.textContent),
    );
    expect(badges.size).toBeGreaterThan(1);
    for (const label of badges) expect(label).not.toBe('终端没检查');
  });

  it('旧响应的没检查技能没有成因：徽标退回“终端没检查”，抽屉按兜底说明', async () => {
    show({
      ...empty,
      skills: [skill(1, { state: 'not_checked' })],
      counts: { ...empty.counts, skills: 1 },
    });
    await userEvent.click(screen.getByRole('tab', { name: 'Skill 1' }));
    expect(within(screen.getByRole('table')).getByText('终端没检查')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '技能 001' }));
    expect(screen.getByRole('dialog')).toHaveTextContent(NOT_CHECKED_CAUSES.check_missing.basis);
  });

  it('脚本没查完的技能：说明不是权限问题，不要求去开启不存在的开关', async () => {
    show({
      ...empty,
      skills: [skill(1, { state: 'not_checked', cause: 'skill_scan_partial' })],
      counts: { ...empty.counts, skills: 1 },
    });
    await userEvent.click(screen.getByRole('tab', { name: 'Skill 1' }));
    await userEvent.click(screen.getByRole('button', { name: '技能 001' }));
    const drawer = screen.getByRole('dialog');
    expect(drawer).toHaveTextContent('不是权限问题');
    expect(drawer).toHaveTextContent('暂时查不了');
    expect(drawer).not.toHaveTextContent(/开启|开关|授权/);
  });

  it('命中说明文档的待确认技能同时有没检查的项时，命中详情和没检查原因都在', async () => {
    show({
      ...empty,
      skills: [
        skill(1, {
          state: 'review',
          cause: 'skill_rules_missing',
          hits: [
            {
              rule: 'x',
              label: '包含下载说明',
              file: 'README.md',
              line: 8,
              contextType: 'document',
            },
          ],
        }),
      ],
      counts: { ...empty.counts, skills: 1 },
    });
    await userEvent.click(screen.getByRole('tab', { name: 'Skill 1' }));
    await userEvent.click(screen.getByRole('button', { name: '技能 001' }));
    const drawer = screen.getByRole('dialog');
    expect(drawer).toHaveTextContent('README.md · 第 8 行 · 说明文档');
    expect(drawer).toHaveTextContent(NOT_CHECKED_CAUSES.skill_rules_missing.title);
  });
});

describe('MCP 抽屉：每个没检查的项说明谁来核对、怎么核对', () => {
  const mcp = (checks: EndpointOverview['mcp'][number]['checks']): EndpointOverview => ({
    ...empty,
    mcp: [
      {
        name: 'ppt',
        transport: 'stdio',
        scope: 'user',
        installedIn: ['Claude Code', 'Claude Desktop'],
        state: 'not_checked',
        checks,
      },
    ],
    counts: { ...empty.counts, mcpServers: 1 },
  });

  it('三类成因各自成块，写明需人工核对；不再是一句“更新探针并重新采集”', async () => {
    show(
      mcp([
        { label: '访问授权', state: 'pass' },
        { label: '依赖组件', state: 'unknown', cause: 'mcp_dependency_unknown' },
        { label: '工具描述', state: 'unknown', cause: 'mcp_descriptions_uncollected' },
        { label: '启动命令', state: 'unknown', cause: 'mcp_launch_unverified' },
      ]),
    );
    await userEvent.click(screen.getByRole('tab', { name: 'MCP 1' }));
    expect(within(screen.getByRole('table')).getByText('3 项没检查')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'ppt' }));
    const drawer = screen.getByRole('dialog');
    for (const key of [
      'mcp_dependency_unknown',
      'mcp_descriptions_uncollected',
      'mcp_launch_unverified',
    ] as const) {
      expect(within(drawer).getAllByText(NOT_CHECKED_CAUSES[key].title)).toHaveLength(1);
      expect(within(drawer).getAllByText(NOT_CHECKED_CAUSES[key].advice)).toHaveLength(1);
    }
    expect(within(drawer).getAllByText('需人工核对')).toHaveLength(3);
    expect(drawer).not.toHaveTextContent('请更新探针并重新采集');
    expect(drawer).not.toHaveTextContent('终端没有提供完整检查结果');
  });

  it('同一成因覆盖多项检查时，成因块标出涉及哪几项', async () => {
    show(
      mcp([
        { label: '依赖组件', state: 'unknown', cause: 'mcp_check_missing' },
        { label: '启动命令', state: 'unknown', cause: 'mcp_check_missing' },
      ]),
    );
    await userEvent.click(screen.getByRole('tab', { name: 'MCP 1' }));
    await userEvent.click(screen.getByRole('button', { name: 'ppt' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('依赖组件、启动命令');
  });

  it('旧响应的 MCP 没有成因键：按兜底说明，仍能看到逐项状态', async () => {
    show(
      mcp([
        { label: '依赖组件', state: 'unknown' },
        { label: '来源', state: 'pass' },
      ]),
    );
    await userEvent.click(screen.getByRole('tab', { name: 'MCP 1' }));
    await userEvent.click(screen.getByRole('button', { name: 'ppt' }));
    const drawer = screen.getByRole('dialog');
    expect(drawer).toHaveTextContent('依赖组件');
    expect(drawer).toHaveTextContent('来源');
    expect(drawer).toHaveTextContent(NOT_CHECKED_CAUSES.mcp_check_missing.basis);
  });
});

describe('智能体抽屉：版本、系统账号、真机测评', () => {
  const agent = (
    patch: Partial<EndpointOverview['agents'][number]> = {},
  ): EndpointOverview['agents'][number] => ({
    key: 'claude-code',
    name: 'Claude Code',
    version: '2.1.308',
    installs: 2,
    configState: 'default',
    configItems: (['permission', 'auto_approval', 'sandbox'] as const).map((item) => ({
      item,
      state: 'default' as const,
      installs: 2,
    })),
    configNote: null,
    issues: 0,
    liveEval: { supported: true, registered: true, reason: null },
    ...patch,
  });

  it('多个版本时在标题下列出其余版本；被折掉的系统账号单独说明，不算安装', async () => {
    show({
      ...empty,
      agents: [agent({ otherVersions: ['2.1.126'], ignoredAccounts: ['libvirt-qemu', 'nobody'] })],
    });
    await userEvent.click(screen.getByRole('tab', { name: '智能体 1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Claude Code' }));
    const drawer = screen.getByRole('dialog');
    expect(drawer).toHaveTextContent('2.1.308 · 另有 2.1.126 · 2 处安装');
    expect(drawer).toHaveTextContent('libvirt-qemu、nobody');
    expect(drawer).toHaveTextContent('不算单独的安装');
  });

  it('真机测评已登记且可用时，抽屉里不再出现这一块', async () => {
    show({ ...empty, agents: [agent()] });
    await userEvent.click(screen.getByRole('tab', { name: '智能体 1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Claude Code' }));
    expect(screen.getByRole('dialog')).not.toHaveTextContent('真机测评条件');
  });

  it('读取失败的智能体：读取失败归管理员，说明符号链接怎么换，不叫人去“开启”什么', async () => {
    show({
      ...empty,
      agents: [
        agent({
          name: 'Codex',
          version: '0.160.1',
          installs: 1,
          configState: 'read_failed',
          configItems: (['permission', 'auto_approval', 'sandbox'] as const).map((item) => ({
            item,
            state: 'read_failed' as const,
            installs: 1,
          })),
        }),
      ],
    });
    await userEvent.click(screen.getByRole('tab', { name: '智能体 1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Codex' }));
    const drawer = screen.getByRole('dialog');
    expect(drawer).toHaveTextContent('需管理员处理');
    expect(drawer).toHaveTextContent('符号链接换成真实文件');
    expect(drawer).not.toHaveTextContent(/开启|开关/);
  });
});

describe('平台抽屉', () => {
  const rules = [
    'secret_key',
    'db_credential',
    'internal_key',
    'admin_auth',
    'signup',
    'code_exec',
    'version',
    'config_read',
  ] as const;
  const platform = (
    patch: Partial<EndpointOverview['platforms'][number]> = {},
  ): EndpointOverview['platforms'][number] => ({
    key: 'dify',
    name: 'Dify',
    version: '1.17.1',
    containers: 1,
    running: 1,
    exposedPorts: 0,
    readState: 'partial',
    issues: 2,
    checks: rules.map((rule) => ({
      rule,
      containers: 1,
      state:
        rule === 'code_exec'
          ? 'risk'
          : rule === 'version'
            ? 'unread'
            : rule === 'config_read'
              ? 'unread'
              : 'clear',
      ...(rule === 'code_exec'
        ? { reasons: ['平台代码执行保护配置存在风险。'], advices: ['启用执行隔离。'] }
        : {}),
      ...(rule === 'version' ? { cause: 'platform_version_unknown' } : {}),
      ...(rule === 'config_read' ? { cause: 'platform_config_partial' } : {}),
    })),
    ...patch,
  });

  it('没读到的项按成因分块说明；已检查无风险折起且不重复判断依据原文', async () => {
    show({ ...empty, platforms: [platform()] });
    await userEvent.click(screen.getByRole('tab', { name: '平台 1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Dify' }));
    const drawer = screen.getByRole('dialog');
    expect(drawer).toHaveTextContent('1.17.1 · 1/1 个容器运行中');
    expect(
      within(drawer).getAllByText(NOT_CHECKED_CAUSES.platform_version_unknown.title),
    ).toHaveLength(1);
    expect(
      within(drawer).getAllByText(NOT_CHECKED_CAUSES.platform_config_partial.title),
    ).toHaveLength(1);
    expect(drawer).toHaveTextContent('平台代码执行保护配置存在风险。');
    expect(drawer).toHaveTextContent('启用执行隔离。');
    expect(drawer.querySelector('details')).not.toHaveAttribute('open');
    expect(drawer).toHaveTextContent('已检查无风险 5 项');
  });

  it('旧响应的平台没读到项没有成因键：按“平台这一项没读到”处理', async () => {
    show({
      ...empty,
      platforms: [
        platform({
          checks: [{ rule: 'version', containers: 1, state: 'unread' }],
          issues: 0,
        }),
      ],
    });
    await userEvent.click(screen.getByRole('tab', { name: '平台 1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Dify' }));
    expect(screen.getByRole('dialog')).toHaveTextContent(NOT_CHECKED_CAUSES.platform_unread.title);
  });

  it('20 个平台 × 每个 11 类检查：列表只渲染一页，打开任意一个抽屉都能读完', async () => {
    const all = [
      'secret_key',
      'db_credential',
      'internal_key',
      'admin_auth',
      'signup',
      'code_exec',
      'ssrf',
      'exposure',
      'telemetry',
      'version',
      'config_read',
    ] as const;
    const platforms = Array.from({ length: 20 }, (_, i) =>
      platform({
        key: `p${i}`,
        name: `编排平台 ${i + 1}`,
        checks: all.map((rule, j) => ({
          rule,
          containers: 1,
          state:
            i % 2
              ? j % 3 === 0
                ? ('risk' as const)
                : ('clear' as const)
              : j > 8
                ? ('unread' as const)
                : ('clear' as const),
          ...(i % 2 && j % 3 === 0 ? { reasons: [`原因 ${j}`], advices: [`办法 ${j}`] } : {}),
          ...(!(i % 2) && j > 8
            ? { cause: j === 9 ? 'platform_version_unknown' : 'platform_config_partial' }
            : {}),
        })),
      }),
    );
    show({ ...empty, platforms });
    await userEvent.click(screen.getByRole('tab', { name: '平台 20' }));
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(21);
    await userEvent.click(screen.getByRole('button', { name: '编排平台 2' }));
    const drawer = screen.getByRole('dialog');
    expect(drawer).toHaveTextContent('发现风险');
    expect(drawer).toHaveTextContent('应用密钥');
    expect(drawer.scrollWidth).toBeLessThanOrEqual(drawer.clientWidth + 1);
  });
});
