import { describe, expect, it } from 'vitest';
import { NotebookTabs } from 'lucide-react';
import { NAV_SECTIONS } from './nav-config';

describe('应用台账菜单', () => {
  it('「应用台账」在评估中心 → 评估组，紧跟「终端与智能体」，路径 /ledger，要 ledger:read', () => {
    const entries = NAV_SECTIONS.flatMap((section) =>
      section.groups.flatMap((group) =>
        group.items
          .filter((item) => item.label === '应用台账')
          .map((item) => ({ section: section.label, group, item })),
      ),
    );
    expect(entries).toHaveLength(1);
    const { section, group, item } = entries[0]!;
    expect(section).toBe('评估中心');
    expect(group.label).toBe('评估');
    // 与应用画像一样，不进「全部租户」视角。
    expect(item).toEqual({
      path: '/ledger',
      label: '应用台账',
      icon: NotebookTabs,
      permission: 'ledger:read',
    });
    const paths = group.items.map((i) => i.path);
    expect(paths.indexOf('/ledger')).toBe(paths.indexOf('/fleet') + 1);
  });
});
