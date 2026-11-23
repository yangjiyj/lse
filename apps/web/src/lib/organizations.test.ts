import { describe, expect, it } from 'vitest';
import { flattenOrgTree, orgTreeOf, type OrgNode } from './organizations';

function node(id: string, name: string, children: OrgNode[] = []): OrgNode {
  return { id, name, parentId: null, sort: 0, memberCount: 0, children };
}

describe('flattenOrgTree', () => {
  it('按树的显示顺序摊平，带层级和「总部 / 研发中心」这样的路径', () => {
    const tree = [
      node('hq', '总部', [
        node('rd', '研发中心', [node('sec', '安全组')]),
        node('ops', '运营中心'),
      ]),
    ];
    expect(flattenOrgTree(tree)).toEqual([
      { id: 'hq', name: '总部', path: '总部', level: 1 },
      { id: 'rd', name: '研发中心', path: '总部 / 研发中心', level: 2 },
      { id: 'sec', name: '安全组', path: '总部 / 研发中心 / 安全组', level: 3 },
      { id: 'ops', name: '运营中心', path: '总部 / 运营中心', level: 2 },
    ]);
  });
});

describe('orgTreeOf', () => {
  it('嵌套的树转成 id → 上级 的表，上级按嵌套关系算', () => {
    const tree = orgTreeOf([node('hq', '总部', [node('rd', '研发中心', [node('sec', '安全组')])])]);
    expect([...tree.values()]).toEqual([
      { id: 'hq', parentId: null },
      { id: 'rd', parentId: 'hq' },
      { id: 'sec', parentId: 'rd' },
    ]);
  });
});
