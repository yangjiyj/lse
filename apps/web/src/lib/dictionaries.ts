import { request } from '@/lib/api';

// 数据字典（系统管理 → 数据字典）的前端类型与请求，与 apps/api/src/modules/dictionaries/routes.ts 对应。

export interface DictTypeView {
  id: string;
  code: string;
  name: string;
  description: string | null;
  builtin: boolean;
  itemCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface DictItemView {
  id: string;
  typeId: string;
  value: string;
  label: string;
  sort: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DictTypeDetail extends DictTypeView {
  items: DictItemView[];
}

export interface DictTypeInput {
  code: string;
  name: string;
  description?: string | null;
}

export interface DictItemInput {
  value: string;
  label: string;
}

const path = (code: string) => `/dictionaries/${encodeURIComponent(code)}`;

export const dictionaryApi = {
  listTypes: () => request<{ items: DictTypeView[] }>('GET', '/dictionaries'),
  getType: (code: string) => request<DictTypeDetail>('GET', path(code)),
  /** 业务取用：只含启用的条目，按排序。 */
  enabledItems: (code: string) => request<{ items: DictItemView[] }>('GET', `${path(code)}/items`),
  createType: (body: DictTypeInput) => request<DictTypeView>('POST', '/dictionaries', { body }),
  updateType: (code: string, body: Partial<Omit<DictTypeInput, 'code'>>) =>
    request<DictTypeView>('PATCH', path(code), { body }),
  deleteType: (code: string) => request<{ ok: true }>('DELETE', path(code)),
  createItem: (code: string, body: DictItemInput & { enabled?: boolean }) =>
    request<DictItemView>('POST', `${path(code)}/items`, { body }),
  updateItem: (
    code: string,
    id: string,
    body: Partial<DictItemInput & { enabled: boolean; sort: number }>,
  ) => request<DictItemView>('PATCH', `${path(code)}/items/${encodeURIComponent(id)}`, { body }),
  deleteItem: (code: string, id: string) =>
    request<{ ok: true }>('DELETE', `${path(code)}/items/${encodeURIComponent(id)}`),
  reorder: (code: string, ids: string[]) =>
    request<{ items: DictItemView[] }>('PUT', `${path(code)}/items/order`, { body: { ids } }),
};
