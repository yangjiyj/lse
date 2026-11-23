import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { expect, it } from 'vitest';
import type { EndpointOverview } from '../../../../../packages/shared/src/endpoint-overview';
import { EndpointOverviewLists } from './EndpointOverviewLists';
import { installRowsFixture, overviewFixture } from './endpoint-overview.test-data';

async function open(agents: EndpointOverview['agents'], exportRef?: { current: (() => void) | null }) {
  render(
    <MemoryRouter>
      <EndpointOverviewLists overview={{ ...overviewFixture, agents }} exportRef={exportRef} />
    </MemoryRouter>,
  );
  await userEvent.click(screen.getByRole('tab', { name: `智能体 ${agents.length}` }));
}
const table = () => screen.getByRole('table');

it('任务没有记录配置读取状态时显示中性灰的“任务未记录”，不写“没读到”', async () => {
  await open(installRowsFixture([1]));
  const tag = within(table()).getByText('任务未记录');
  expect(within(table()).queryByText('没读到')).not.toBeInTheDocument();
  expect(tag.className).toContain('bg-severity-unknown-bg');
  expect(tag.className).not.toMatch(/severity-(medium|high|critical|low)|#B42318|red|amber/);
  expect(document.body).not.toHaveTextContent('历史任务未记录配置读取状态');
});

it('任务未记录的智能体，抽屉不再列出三项“没读到”，也没有补充说明句', async () => {
  await open(installRowsFixture([1]));
  await userEvent.click(screen.getByRole('button', { name: '产品 1' }));
  const drawer = screen.getByRole('dialog');
  expect(drawer).not.toHaveTextContent('没读到');
  expect(drawer).not.toHaveTextContent('权限模式');
  expect(drawer).not.toHaveTextContent('请重新采集');
  expect(drawer).toHaveTextContent('真机测评条件');
});

it('配置读取状态有记录的才显示六态，沿用终端页的标签', async () => {
  const states = ['checked', 'default', 'partial', 'internal_store', 'read_failed', 'not_checked'] as const;
  await open(
    installRowsFixture([7], (row, _p, i) => {
      if (i < 6) row.configState = states[i]!;
    }),
  );
  for (const label of ['已读到', '按默认值', '部分读到', '不在配置文件里', '读取失败', '没读到', '任务未记录'])
    expect(within(table()).getByText(label)).toBeInTheDocument();
});

it('同一产品出现多行时名称下方标出账号和位置，只有一行的产品不显示', async () => {
  await open(installRowsFixture([3, 1]));
  for (let i = 1; i <= 3; i++) expect(screen.getByText(`账号${i} · ~/.产品1-安装${i}`)).toBeInTheDocument();
  const rows = within(table()).getAllByRole('row');
  expect(rows).toHaveLength(5);
  expect(rows[4]!.querySelector('[title]')).toBeNull();
  expect(rows[4]).not.toHaveTextContent('~/.产品2');
});

it('位置或账号只有一项时只写那一项，两项都没有时不留空行', async () => {
  await open(
    installRowsFixture([3], (row, _p, i) => {
      if (i === 0) row.account = null;
      if (i === 1) row.location = null;
      if (i === 2) {
        row.account = null;
        row.location = null;
      }
    }),
  );
  expect(screen.getByText('~/.产品1-安装1')).toBeInTheDocument();
  expect(screen.getByText('账号2')).toBeInTheDocument();
  const rows = within(table()).getAllByRole('row');
  expect(rows[3]!.querySelector('[title]')).toBeNull();
});

it('超长位置截断并用悬停显示全文，不撑破布局', async () => {
  const long = `~/${'很长的目录名'.repeat(12)}`;
  await open(
    installRowsFixture([2], (row, _p, i) => {
      if (i === 0) row.location = long;
    }),
  );
  const line = screen.getByText(`账号1 · ${long}`);
  expect(line).toHaveAttribute('title', `账号1 · ${long}`);
  expect(line.className).toMatch(/\btruncate\b/);
  expect(line.className).toMatch(/max-w-/);
});

it('同产品 20 个安装、10 个产品共 60 行：每页 20 行，只给多安装产品标位置，没有重复长句', async () => {
  const counts = [20, 10, 5, 5, 4, 4, 4, 3, 4, 1];
  const agents = installRowsFixture(counts);
  expect(agents).toHaveLength(60);
  await open(agents);
  expect(within(table()).getAllByRole('row')).toHaveLength(21);
  expect(within(table()).getAllByText('任务未记录')).toHaveLength(20);
  const longCells = () =>
    [...table().querySelectorAll('tbody td')].map((td) => td.textContent ?? '').filter((t) => t.length > 12);
  const first = longCells();
  expect(new Set(first).size).toBe(first.length);
  expect(table().querySelectorAll('tbody [title]')).toHaveLength(20);
  await userEvent.click(screen.getByRole('button', { name: '下一页' }));
  await userEvent.click(screen.getByRole('button', { name: '下一页' }));
  expect(within(table()).getAllByRole('row')).toHaveLength(21);
  // 第 3 页最后一行是只有一个安装的产品，不显示位置行
  expect(table().querySelectorAll('tbody [title]')).toHaveLength(19);
  const last = longCells();
  expect(new Set(last).size).toBe(last.length);
  expect(document.body).not.toHaveTextContent('历史任务未记录配置读取状态');
});

it('任务未记录不会被算作“已检查无风险”', async () => {
  await open(installRowsFixture([2]));
  await userEvent.selectOptions(screen.getByLabelText('筛选状态'), 'clear');
  expect(screen.queryByRole('button', { name: '产品 1' })).not.toBeInTheDocument();
  await userEvent.selectOptions(screen.getByLabelText('筛选状态'), 'not_checked');
  expect(screen.getAllByRole('button', { name: '产品 1' })).toHaveLength(2);
});

it('导出清单里“配置是否读到”写任务未记录，同产品多行带上位置区分', async () => {
  const exportRef: { current: (() => void) | null } = { current: null };
  let exported: Blob | undefined;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = ((blob: Blob) => {
    exported = blob;
    return 'blob:agents';
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = () => {};
  try {
    await open(installRowsFixture([2]), exportRef);
    exportRef.current?.();
    const csv = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(exported!);
    });
    expect(csv).toContain('任务未记录');
    expect(csv).not.toContain('没读到');
    expect(csv).toContain('产品 1（账号1 · ~/.产品1-安装1）');
    expect(csv).toContain('产品 1（账号2 · ~/.产品1-安装2）');
  } finally {
    HTMLAnchorElement.prototype.click = click;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});
