import { describe, expect, it } from 'vitest';
import { Layers3 } from 'lucide-react';
import { NAV_SECTIONS } from './nav-config';

describe('batch evaluation navigation', () => {
  it('places the permitted batch entry inside evaluation center without changing other sections', () => {
    const entries = NAV_SECTIONS.flatMap((section) =>
      section.groups.flatMap((group) =>
        group.items
          .filter((item) => item.path === '/batch-evaluations')
          .map((item) => ({ section: section.label, group: group.label, item })),
      ),
    );
    expect(entries).toEqual([
      {
        section: '评估中心',
        group: '评估',
        item: {
          path: '/batch-evaluations',
          label: '批量评估',
          icon: Layers3,
          permission: 'eval_task:read',
        },
      },
    ]);
  });

  it('热力图并入框架覆盖页后，导航里不再有独立的框架映射入口', () => {
    const paths = NAV_SECTIONS.flatMap((section) =>
      section.groups.flatMap((group) => group.items.map((item) => item.path)),
    );
    expect(paths).not.toContain('/risk/framework-map');
    expect(paths).toContain('/reports/framework-coverage');
    expect(paths).toContain('/reports/standard-clauses');
  });
});
