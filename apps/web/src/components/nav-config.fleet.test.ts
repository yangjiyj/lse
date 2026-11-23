import { describe, expect, it } from 'vitest';
import { Laptop } from 'lucide-react';
import { NAV_SECTIONS } from './nav-config';

describe('终端导航', () => {
  it('「终端与智能体」位于评估中心 → 评估组，紧跟「评估对象」', () => {
    const group = NAV_SECTIONS.find((s) => s.label === '评估中心')!.groups.find(
      (g) => g.label === '评估',
    )!;
    const paths = group.items.map((i) => i.path);
    expect(paths.indexOf('/fleet')).toBe(paths.indexOf('/model-targets') + 1);
    expect(group.items.find((i) => i.path === '/fleet')).toEqual({
      path: '/fleet',
      label: '终端与智能体',
      icon: Laptop,
      permission: 'model_target:read',
      allTenantsAllowed: true,
    });
    expect(group.items.find((i) => i.path === '/agent-samples')?.label).toBe('智能体样本库');
    expect(group.items.find((i) => i.path === '/question-sets')?.label).toBe('模型题库');
  });
});
