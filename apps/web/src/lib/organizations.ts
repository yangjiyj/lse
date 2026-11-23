import { MAX_ORG_DEPTH, type OrgTreeRow } from '@lse/shared';
import { request, type Paginated } from '@/lib/api';

// 组织架构（系统管理 → 组织架构）的前端类型与请求，与 apps/api/src/modules/organizations/routes.ts 对应。

export interface OrgNode {
  id: string;
  name: string;
  parentId: string | null;
  sort: number;
  /** 直属成员数 */
  memberCount: number;
  children: OrgNode[];
}

export interface OrgTenantGroup {
  tenantId: string;
  tenantName: string;
  items: OrgNode[];
}

/** 普通视角返回 items；「全部租户」视角按租户分组返回 groups。 */
export interface OrgTreeResponse {
  items?: OrgNode[];
  groups?: OrgTenantGroup[];
}

export interface OrgMember {
  id: string;
  username: string;
  displayName: string;
  isActive: boolean;
  organizationId: string | null;
  organizationPath: string | null;
}

export interface OrgInput {
  name: string;
  parentId?: string | null;
  sort?: number;
}

const path = (id: string) => `/organizations/${encodeURIComponent(id)}`;

export const organizationApi = {
  tree: (query?: { tenantId?: string }) =>
    request<OrgTreeResponse>('GET', '/organizations', { query }),
  members: (
    id: string,
    query: { includeDescendants?: boolean; page?: number; pageSize?: number },
  ) => request<Paginated<OrgMember>>('GET', `${path(id)}/members`, { query }),
  create: (body: OrgInput) => request<OrgNode>('POST', '/organizations', { body }),
  update: (id: string, body: Partial<OrgInput>) => request<OrgNode>('PATCH', path(id), { body }),
  remove: (id: string) => request<{ ok: true }>('DELETE', path(id)),
};

/** 组织树最多几级，前后端共用 @lse/shared 的定义。 */
export { MAX_ORG_DEPTH };

/** 组织路径的分隔，与后端一致：「总部 / 研发中心 / 安全组」。 */
export const ORG_PATH_SEPARATOR = ' / ';

export interface OrgOption {
  id: string;
  name: string;
  /** 「总部 / 研发中心」 */
  path: string;
  /** 根 = 1 */
  level: number;
}

/** 树按显示顺序摊平（先序），带路径和层级；下拉框、按 id 查路径都用它。 */
export function flattenOrgTree(nodes: OrgNode[], parentPath = '', level = 1): OrgOption[] {
  return nodes.flatMap((node) => {
    const nodePath = parentPath ? `${parentPath}${ORG_PATH_SEPARATOR}${node.name}` : node.name;
    return [
      { id: node.id, name: node.name, path: nodePath, level },
      ...flattenOrgTree(node.children, nodePath, level + 1),
    ];
  });
}

/** 嵌套的树转成 id → { id, parentId }（上级按嵌套关系算），给 @lse/shared 的树校验用。 */
export function orgTreeOf(
  nodes: OrgNode[],
  parentId: string | null = null,
): Map<string, OrgTreeRow> {
  const out = new Map<string, OrgTreeRow>();
  for (const node of nodes) {
    out.set(node.id, { id: node.id, parentId });
    for (const [id, row] of orgTreeOf(node.children, node.id)) out.set(id, row);
  }
  return out;
}
