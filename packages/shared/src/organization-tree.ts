// 组织架构（2.9.3）的树校验，前后端共用：后端改上级时据此拒绝，前端「移动」弹窗据此过滤目标。

/** 组织树最多几级（需求是不低于三级），根节点算第 1 级。 */
export const MAX_ORG_DEPTH = 8;

export interface OrgTreeRow {
  id: string;
  parentId: string | null;
}

/** id → 行。 */
export type OrgTree = ReadonlyMap<string, OrgTreeRow>;

/** 移动行不通的原因：cycle = 移到自己或自己的下级下；too_deep = 超过 MAX_ORG_DEPTH 级。 */
export type OrgMoveProblem = 'cycle' | 'too_deep';

function childrenIndex(tree: OrgTree): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const row of tree.values()) {
    if (!row.parentId) continue;
    const list = index.get(row.parentId) ?? [];
    list.push(row.id);
    index.set(row.parentId, list);
  }
  return index;
}

/** 节点所在层级（根 = 1）。数据异常成环时按节点数截断，不会死循环。 */
export function orgDepth(tree: OrgTree, id: string): number {
  let depth = 0;
  let cur: string | null = id;
  while (cur && depth <= tree.size) {
    const row = tree.get(cur);
    if (!row) break;
    depth += 1;
    cur = row.parentId;
  }
  return depth;
}

/** 节点本身加全部下级的 id（广度优先）。 */
export function orgSubtreeIds(tree: OrgTree, id: string): string[] {
  const index = childrenIndex(tree);
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    queue.push(...(index.get(cur) ?? []));
  }
  return out;
}

/** 以该节点为根的子树有几级（只有自己 = 1）。 */
export function orgSubtreeHeight(tree: OrgTree, id: string): number {
  const index = childrenIndex(tree);
  const height = (cur: string, guard: number): number => {
    if (guard > tree.size) return guard;
    const kids = index.get(cur) ?? [];
    return 1 + kids.reduce((max, kid) => Math.max(max, height(kid, guard + 1)), 0);
  };
  return height(id, 1);
}

/**
 * 把 id 移到 parentId 下（null = 顶级）有什么问题，没有返回 null。
 * 目标层级 + 子树高度 ≤ MAX_ORG_DEPTH 才行。上级存不存在由调用方判断。
 */
export function orgMoveProblem(
  tree: OrgTree,
  id: string,
  parentId: string | null,
): OrgMoveProblem | null {
  if (!parentId) return null;
  if (orgSubtreeIds(tree, id).includes(parentId)) return 'cycle';
  if (orgDepth(tree, parentId) + orgSubtreeHeight(tree, id) > MAX_ORG_DEPTH) return 'too_deep';
  return null;
}
