import { describe, expect, it } from 'vitest';
import { DETECT_RISK_PERMISSIONS } from '@/lib/detect-risks';
import { NAV_SECTIONS } from './nav-config';

const ENTRIES = NAV_SECTIONS.flatMap((section) =>
  section.groups.flatMap((group) => group.items.map((item) => ({ section, group, item }))),
);

describe('导航配置', () => {
  it('每个菜单项的图标互不相同，侧栏一眼能分辨', () => {
    const seen = new Map<unknown, string>();
    const duplicated: string[] = [];
    for (const { item } of ENTRIES) {
      const prev = seen.get(item.icon);
      if (prev) duplicated.push(`${prev} / ${item.label}`);
      else seen.set(item.icon, item.label);
    }
    expect(duplicated).toEqual([]);
  });

  it('一级菜单九个，顺序固定', () => {
    expect(NAV_SECTIONS.map((s) => s.label)).toEqual([
      '工作台',
      '评估中心',
      '专项核验',
      '工具中心',
      '数据安全',
      '数据分析',
      '风险处置',
      '报告中心',
      '系统管理',
    ]);
  });

  it('「全部任务」在工作台，排在态势概览、我的待办之后，要 detect_task:read，全部租户视角可见', () => {
    const workbench = NAV_SECTIONS.find((s) => s.label === '工作台')!;
    expect(workbench.groups.flatMap((g) => g.items.map((i) => i.path))).toEqual([
      '/',
      '/my-todos',
      '/detect-tasks',
    ]);
    const overview = ENTRIES.find(({ item }) => item.path === '/detect-tasks')!;
    expect(overview.section.label).toBe('工作台');
    expect(overview.item.label).toBe('全部任务');
    expect(overview.item.permission).toBe('detect_task:read');
    expect(overview.item.allTenantsAllowed).toBe(true);
  });

  it('报告中心有「报告模板」，要 report:read', () => {
    const entry = ENTRIES.find(({ item }) => item.path === '/reports/templates')!;
    expect(entry.section.label).toBe('报告中心');
    expect(entry.item.label).toBe('报告模板');
    expect(entry.item.permission).toBe('report:read');
  });

  it('组合任务在评估中心「评估」组的批量评估之后，检测策略在「持续评估」组的评估计划之后', () => {
    for (const [path, label, group, after] of [
      ['/detect-tasks/jobs', '组合任务', '评估', '/batch-evaluations'],
      ['/detect-tasks/strategies', '检测策略', '持续评估', '/eval/plans'],
    ] as const) {
      const entry = ENTRIES.find(({ item }) => item.path === path)!;
      expect(entry.section.label).toBe('评估中心');
      expect(entry.group.label).toBe(group);
      expect(entry.item.label).toBe(label);
      expect(entry.item.permission).toBe('detect_task:read');
      const paths = entry.group.items.map((i) => i.path);
      expect(paths.indexOf(path)).toBe(paths.indexOf(after) + 1);
    }
  });

  it('没有「检测方案」：一级菜单、菜单项、/schemes 路径、方案权限都不出现', () => {
    const sections = NAV_SECTIONS.map((s) => s.label);
    expect(sections).not.toContain('检测方案');
    expect(sections).not.toContain('检测任务');
    for (const { group, item } of ENTRIES) {
      expect(item.label).not.toBe('检测方案');
      expect(group.label).not.toBe('检测方案');
      expect(item.path.startsWith('/schemes')).toBe(false);
      const codes = [item.permission ?? []].flat();
      expect(codes.filter((code) => code.startsWith('scheme:'))).toEqual([]);
    }
  });

  it('路径不重复', () => {
    const paths = ENTRIES.map(({ item }) => item.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('菜单名与全站术语表一致', () => {
    const labels = ENTRIES.map(({ item }) => item.label);
    for (const expected of ['任务对比', '报告管理', 'AI 组件漏洞扫描', '智能体样本库', '模型题库']) {
      expect(labels).toContain(expected);
    }
    for (const forbidden of ['多模型对比分析', '报告查看', '智能体资产复核']) {
      expect(labels.some((label) => label.includes(forbidden))).toBe(false);
    }
    expect(labels.some((label) => label.includes('评测'))).toBe(false);
    expect(labels).not.toContain('外部资产评审');
    expect(labels).not.toContain('API 令牌');
    expect(labels).toContain('评估计划');
    expect(labels).toContain('上线门禁');
  });

  it('「数据分析」一级分组紧跟「数据安全」，检测结果有任一风险来源权限即可看', () => {
    const sections = NAV_SECTIONS.map((section) => section.label);
    expect(sections.indexOf('数据分析')).toBe(sections.indexOf('数据安全') + 1);
    const items = NAV_SECTIONS.find((section) => section.label === '数据分析')!.groups.flatMap(
      (group) => group.items,
    );
    const results = items.find((item) => item.path === '/analysis/results');
    expect(results?.label).toBe('检测结果');
    expect([...(results?.permission ?? [])].sort()).toEqual([...DETECT_RISK_PERMISSIONS].sort());
    expect(results?.allTenantsAllowed).toBe(true);
    const profiles = items.find((item) => item.path === '/analysis/profiles');
    expect(profiles?.label).toBe('应用画像');
    expect(profiles?.permission).toBe('ledger:read');
    // 与应用台账一样，不进「全部租户」视角。
    expect(profiles?.allTenantsAllowed).toBeFalsy();
  });
});
