import { describe, expect, it } from 'vitest';
import { NAV_SECTIONS } from './nav-config';

function find(path: string) {
  return NAV_SECTIONS.flatMap((section) =>
    section.groups.flatMap((group) =>
      group.items
        .filter((item) => item.path === path)
        .map((item) => ({ section: section.label, item })),
    ),
  );
}

describe('W6 系统管理菜单', () => {
  it('「数据字典」在系统管理下，需要查看系统设置权限，只在平台租户显示，全部租户视角可用', () => {
    const entries = find('/system/dictionaries');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.section).toBe('系统管理');
    expect(entries[0]!.item.label).toBe('数据字典');
    expect(entries[0]!.item.permission).toBe('system_setting:read');
    expect(entries[0]!.item.platformOnly).toBe(true);
    expect(entries[0]!.item.allTenantsAllowed).toBe(true);
  });
});

describe('W6 工单处理菜单', () => {
  it('「工单处理」在系统管理下，需要 support:manage，只在平台租户显示，全部租户视角可用', () => {
    const entries = find('/system/support-tickets');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.section).toBe('系统管理');
    expect(entries[0]!.item.label).toBe('工单处理');
    expect(entries[0]!.item.permission).toBe('support:manage');
    expect(entries[0]!.item.platformOnly).toBe(true);
    expect(entries[0]!.item.allTenantsAllowed).toBe(true);
  });
});

describe('二期 D 组织架构菜单', () => {
  it('「组织架构」在系统管理下，需要 org:read，各租户都显示，全部租户视角可用', () => {
    const entries = find('/system/organizations');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.section).toBe('系统管理');
    expect(entries[0]!.item.label).toBe('组织架构');
    expect(entries[0]!.item.permission).toBe('org:read');
    expect(entries[0]!.item.platformOnly).toBeFalsy();
    expect(entries[0]!.item.allTenantsAllowed).toBe(true);
  });
});
