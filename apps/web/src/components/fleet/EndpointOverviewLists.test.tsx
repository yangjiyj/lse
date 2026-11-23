import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { EndpointOverviewLists } from './EndpointOverviewLists';
import { overviewFixture } from './endpoint-overview.test-data';

function open() {
  render(
    <MemoryRouter>
      <EndpointOverviewLists overview={overviewFixture} />
    </MemoryRouter>,
  );
}
it('uses fleet job status labels in the endpoint history', async () => {
  const overview = {
    ...overviewFixture,
    history: [{ taskId: 'job-1', mode: 'live' as const, modeLabel: '真机测评',
      createdAt: '2026-10-25T02:30:00Z', status: 'QUEUED', summaryLine: '请查看执行状态。' }],
  };
  render(<MemoryRouter><EndpointOverviewLists overview={overview} /></MemoryRouter>);
  await userEvent.click(screen.getByRole('tab', { name: '检测记录 1' }));
  expect(screen.getByRole('table')).toHaveTextContent('待终端领取');
  expect(screen.getByRole('table')).not.toHaveTextContent('状态未知');
});
it('风险默认展示，抽屉提供涉及明细、剩余数量和处理建议', async () => {
  open();
  expect(screen.getAllByRole('row')).toHaveLength(8);
  await userEvent.click(screen.getByRole('button', { name: '权限问题 1' }));
  const drawer = screen.getByRole('dialog');
  expect(within(drawer).getByText('Claude Code')).toBeInTheDocument();
  expect(within(drawer).getByText('另有 2 个')).toBeInTheDocument();
  expect(within(drawer).getByText('收紧授权后重新检测')).toBeInTheDocument();
});
it('88 个技能每页只渲染 20 行，可以分页、搜索与筛选', async () => {
  open();
  await userEvent.click(screen.getByRole('tab', { name: 'Skill 88' }));
  expect(screen.getAllByRole('row')).toHaveLength(21);
  expect(screen.queryByText('技能 88')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '下一页' }));
  expect(screen.getByText('技能 21')).toBeInTheDocument();
  await userEvent.type(screen.getByRole('searchbox'), '技能 88');
  expect(screen.getByText('技能 88')).toBeInTheDocument();
  expect(screen.getAllByRole('row')).toHaveLength(2);
  await userEvent.clear(screen.getByRole('searchbox'));
  await userEvent.selectOptions(screen.getByLabelText('筛选状态'), 'review');
  await userEvent.click(screen.getByRole('button', { name: '技能 01' }));
  expect(screen.getByRole('dialog')).toHaveTextContent(
    '待确认：命中出现在说明文档里，不是可执行脚本',
  );
  expect(screen.getByRole('dialog')).toHaveTextContent('README.md · 第 8 行 · 说明文档');
});
it('没检查、已检查无风险与发现风险保持独立三态', async () => {
  open();
  await userEvent.click(screen.getByRole('tab', { name: 'MCP 1' }));
  await userEvent.click(screen.getByRole('button', { name: '文件服务' }));
  const drawer = screen.getByRole('dialog');
  expect(within(drawer).getByText('终端没检查')).toBeInTheDocument();
  expect(within(drawer).getByText('已检查无风险')).toBeInTheDocument();
  expect(within(drawer).getByText('发现风险')).toBeInTheDocument();
});
it('8 个智能体按产品展示，没读到配置提供原因和办法', async () => {
  open();
  await userEvent.click(screen.getByRole('tab', { name: '智能体 8' }));
  expect(screen.getAllByRole('row')).toHaveLength(9);
  expect(screen.getByText('没读到')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '智能体 8' }));
  const drawer = screen.getByRole('dialog');
  // 权限与自动批准没读到：说明为什么、谁来处理、怎么办；不再出现旧的整句 configNote
  expect(drawer).toHaveTextContent('权限与自动批准设置没读到');
  expect(drawer).toHaveTextContent('暂时查不了');
  expect(drawer).toHaveTextContent('办法');
  expect(drawer).not.toHaveTextContent('终端没有读取权限；请授权后重新上报');
});
it('页头可以导出当前筛选清单，文档命中风险自动降为待确认', async () => {
  const fixture = {
    ...overviewFixture,
    skills: overviewFixture.skills.map((s, i) => (i === 0 ? { ...s, state: 'risk' as const } : s)),
  };
  render(
    <MemoryRouter>
      <EndpointOverviewLists overview={fixture} />
    </MemoryRouter>,
  );
  await userEvent.click(screen.getByRole('tab', { name: 'Skill 88' }));
  await userEvent.selectOptions(screen.getByLabelText('筛选状态'), 'review');
  expect(screen.getAllByRole('row')).toHaveLength(2);
  expect(screen.getByRole('table')).toHaveTextContent('待确认');
  expect(screen.getByRole('table')).not.toHaveTextContent('高危');
});

it('导出当前筛选结果，包括表头且不会带入其他页签', async () => {
  const exportRef: { current: (() => void) | null } = { current: null };
  let exported: Blob | undefined;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = vi.fn((blob) => {
    exported = blob as Blob;
    return 'blob:overview';
  });
  URL.revokeObjectURL = vi.fn();
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  try {
    render(
      <MemoryRouter>
        <EndpointOverviewLists overview={overviewFixture} exportRef={exportRef} />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Skill 88' }));
    await userEvent.type(screen.getByRole('searchbox'), '技能 88');
    exportRef.current?.();
    const csv = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(exported!);
    });
    expect(csv).toContain('"名称","来源","装在哪","状态"');
    expect(csv).toContain('技能 88');
    expect(csv).not.toContain('技能 01');
    expect(click).toHaveBeenCalledTimes(1);
  } finally {
    click.mockRestore();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});

it('六种配置标签、三项设置及计数和没检查筛选均如实显示', async () => {
  const states = [
    'checked',
    'default',
    'partial',
    'internal_store',
    'read_failed',
    'not_checked',
  ] as const;
  const fixture = {
    ...overviewFixture,
    agents: states.map((state, i) => ({
      ...overviewFixture.agents[i]!,
      name: `配置智能体 ${i}`,
      configState: state,
      installs: 2,
      issues: 0,
      configNote: '该软件把这项设置保存在内部，探针读不到，需要在软件里确认。',
      configItems: [
        { item: 'permission' as const, state: 'internal_store' as const, installs: 2 },
        { item: 'auto_approval' as const, state: 'internal_store' as const, installs: 2 },
        { item: 'sandbox' as const, state: 'explicit' as const, installs: 1 },
        { item: 'sandbox' as const, state: 'unknown' as const, installs: 1 },
      ],
    })),
  };
  render(
    <MemoryRouter>
      <EndpointOverviewLists overview={fixture} />
    </MemoryRouter>,
  );
  await userEvent.click(screen.getByRole('tab', { name: '智能体 6' }));
  for (const label of ['已读到', '按默认值', '部分读到', '不在配置文件里', '读取失败', '没读到'])
    expect(within(screen.getByRole('table')).getByText(label)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '配置智能体 3' }));
  const drawer = within(screen.getByRole('dialog'));
  for (const label of ['权限模式', '自动批准', '沙箱'])
    expect(drawer.getByText(label)).toBeInTheDocument();
  expect(drawer.getAllByText('不在配置文件里')).toHaveLength(2);
  expect(drawer.getByText(/已读到.*1 处/)).toBeInTheDocument();
  // 副标题写总安装数；三项设置里，覆盖全部安装的状态不再加“2 处”后缀
  expect(drawer.getByText(/2 处安装/)).toBeInTheDocument();
  expect(drawer.queryByText(/^不在配置文件里 2 处$/)).not.toBeInTheDocument();
  // “不在配置文件里”这一类的原因和办法只写一次，且标明由人工核对
  expect(drawer.getAllByText('设置不在配置文件里')).toHaveLength(1);
  expect(drawer.getByText('需人工核对')).toBeInTheDocument();
  expect(screen.getByRole('dialog')).not.toHaveTextContent(/internal_store|default|read_failed/);
  await userEvent.click(screen.getByRole('button', { name: '关闭详情' }));
  await userEvent.selectOptions(screen.getByLabelText('筛选状态'), 'not_checked');
  expect(screen.getAllByRole('row')).toHaveLength(4);
  for (const i of [3, 4, 5])
    expect(screen.getByRole('button', { name: `配置智能体 ${i}` })).toBeInTheDocument();
  await userEvent.selectOptions(screen.getByLabelText('筛选状态'), 'clear');
  expect(screen.getByRole('button', { name: '配置智能体 1' })).toBeInTheDocument();
});

const platformRules = [
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
const platformFixture = () => ({
  ...overviewFixture,
  platforms: Array.from({ length: 20 }, (_, i) => ({
    key: `platform-${i}`,
    name: `编排平台 ${i + 1}`,
    version: '1.0',
    containers: 2,
    running: 1,
    exposedPorts: i === 0 ? 1 : 0,
    readState:
      i === 1 ? ('not_checked' as const) : i === 2 ? ('partial' as const) : ('complete' as const),
    issues: i === 0 ? 5 : 0,
    checks:
      i === 1
        ? []
        : platformRules.map((rule, j) => ({
            rule,
            state:
              i === 0 && j < 5
                ? ('risk' as const)
                : i === 2
                  ? ('unread' as const)
                  : ('clear' as const),
            containers: 2,
            reasons: ['相同原因只显示一次。'],
          })),
  })),
});
it('无平台及旧响应不增加空页签', () => {
  open();
  expect(screen.queryByRole('tab', { name: /^平台/ })).not.toBeInTheDocument();
});
it('20 平台与 11 分类默认折叠，三态、对外端口与原因不混淆', async () => {
  render(
    <MemoryRouter>
      <EndpointOverviewLists overview={platformFixture()} />
    </MemoryRouter>,
  );
  await userEvent.click(screen.getByRole('tab', { name: '平台 20' }));
  expect(screen.getAllByRole('row')).toHaveLength(21);
  expect(screen.queryByText('相同原因只显示一次。')).not.toBeInTheDocument();
  expect(screen.getByText('+2')).toBeInTheDocument();
  expect(screen.getByText('1 个对外')).toBeInTheDocument();
  expect(screen.getByText('未体检')).toBeInTheDocument();
  expect(screen.getByText('10 项没读到')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '编排平台 1' }));
  const drawer = screen.getByRole('dialog');
  expect(within(drawer).getAllByText('相同原因只显示一次。')).toHaveLength(1);
  // 5 项风险的原因和办法相同：合成一块，项目名并列在一行
  expect(drawer).toHaveTextContent(
    '应用密钥、数据库与缓存口令、组件互访密钥、管理端鉴权、开放注册',
  );
  expect(drawer.querySelectorAll('details[open]')).toHaveLength(0);
  await userEvent.click(screen.getByRole('button', { name: '关闭详情' }));
  await userEvent.click(screen.getByRole('button', { name: '编排平台 2' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('平台没有做配置体检');
  expect(screen.getByRole('dialog')).toHaveTextContent('升级到最新版本');
  expect(screen.getByRole('dialog')).not.toHaveTextContent('已检查无风险');
});
it('平台风险显示中文类别', () => {
  const fixture = {
    ...overviewFixture,
    risks: [
      {
        ...overviewFixture.risks[0]!,
        category: 'platform' as const,
        title: 'Dify 的管理端鉴权配置存在风险',
      },
    ],
  };
  render(
    <MemoryRouter>
      <EndpointOverviewLists overview={fixture} />
    </MemoryRouter>,
  );
  expect(within(screen.getByRole('table')).getByText('平台')).toBeInTheDocument();
});

it('平台剩余风险标签可独立展开，不会打开详情抽屉', async () => {
  render(
    <MemoryRouter>
      <EndpointOverviewLists overview={platformFixture()} />
    </MemoryRouter>,
  );
  await userEvent.click(screen.getByRole('tab', { name: '平台 20' }));
  await userEvent.click(screen.getByText('+2'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByText('+2').closest('details')).toHaveAttribute('open');
});
it('缺少平台字段的旧响应保持兼容', () => {
  const { platforms: _, ...legacy } = overviewFixture;
  render(
    <MemoryRouter>
      <EndpointOverviewLists overview={legacy as typeof overviewFixture} />
    </MemoryRouter>,
  );
  expect(screen.queryByRole('tab', { name: /^平台/ })).not.toBeInTheDocument();
});

it('风险表定宽：状态与类别不换行，问题与依据列各自限高，不会被一条长依据撑成几百像素', async () => {
  const long = '该智能体配置了绕过权限确认或自动批准。'.repeat(30);
  const fixture = {
    ...overviewFixture,
    risks: overviewFixture.risks.map((r, i) => (i === 0 ? { ...r, basis: long, category: 'coverage' as const } : r)),
  };
  render(
    <MemoryRouter>
      <EndpointOverviewLists overview={fixture} />
    </MemoryRouter>,
  );
  const table = screen.getByRole('table');
  expect(table.querySelector('colgroup')).not.toBeNull();
  const firstRow = screen.getAllByRole('row')[1]!;
  const cells = within(firstRow).getAllByRole('cell');
  // 类别、状态两列不允许竖排折行（等级是徽标，自带不换行）
  for (const index of [1, 5]) expect(cells[index]!.className).toContain('whitespace-nowrap');
  // 依据列限制为 2 行并可悬停看全文
  const basis = within(firstRow).getByTitle(long);
  expect(basis.className).toContain('line-clamp-2');
  expect(basis).toHaveTextContent(long.slice(0, 20));
});
it('涉及列也限制行数，长名单悬停看全文，点开行进入抽屉看逐项明细', async () => {
  const names = 'Claude Code、Codex、Hermes、OpenClaw、OpenCode、未识别的智能体（原始标识：claude-desktop）';
  const fixture = {
    ...overviewFixture,
    risks: overviewFixture.risks.map((r, i) => (i === 0 ? { ...r, involved: names } : r)),
  };
  render(
    <MemoryRouter>
      <EndpointOverviewLists overview={fixture} />
    </MemoryRouter>,
  );
  const cell = within(screen.getAllByRole('row')[1]!).getByTitle(names);
  expect(cell.className).toContain('line-clamp-2');
});

it('抽屉里所有对象的说明都与依据相同时，说明只写一次，不在每个对象下重复', async () => {
  const text = '该智能体配置了绕过权限确认或自动批准。';
  const fixture = {
    ...overviewFixture,
    risks: overviewFixture.risks.map((r, i) =>
      i === 0
        ? {
            ...r,
            basis: text,
            subjects: ['Claude Code', 'Hermes', 'OpenCode'].map((name) => ({ name, detail: text })),
            moreCount: 0,
          }
        : r,
    ),
  };
  render(
    <MemoryRouter>
      <EndpointOverviewLists overview={fixture} />
    </MemoryRouter>,
  );
  await userEvent.click(screen.getByRole('button', { name: '权限问题 1' }));
  const drawer = screen.getByRole('dialog');
  expect(within(drawer).getAllByText(text)).toHaveLength(1);
  for (const name of ['Claude Code', 'Hermes', 'OpenCode'])
    expect(within(drawer).getByText(name)).toBeInTheDocument();
});
it('对象说明各不相同时仍逐个显示', async () => {
  const fixture = {
    ...overviewFixture,
    risks: overviewFixture.risks.map((r, i) =>
      i === 0
        ? {
            ...r,
            basis: '总体依据',
            subjects: [
              { name: 'A', detail: '甲的说明' },
              { name: 'B', detail: '乙的说明' },
            ],
            moreCount: 0,
          }
        : r,
    ),
  };
  render(
    <MemoryRouter>
      <EndpointOverviewLists overview={fixture} />
    </MemoryRouter>,
  );
  await userEvent.click(screen.getByRole('button', { name: '权限问题 1' }));
  const drawer = screen.getByRole('dialog');
  expect(within(drawer).getByText('甲的说明')).toBeInTheDocument();
  expect(within(drawer).getByText('乙的说明')).toBeInTheDocument();
});
