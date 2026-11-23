import { request, type Paginated } from '@/lib/api';
import type { BadgeTone } from '@/lib/format';

// 技术支持与意见反馈工单，与 apps/api/src/modules/support-tickets/routes.ts 对应。

export type SupportTicketKind = 'SUPPORT' | 'FEEDBACK';
export type SupportTicketStatus = 'OPEN' | 'REPLIED' | 'CLOSED';

export const SUPPORT_KIND_LABELS: Record<SupportTicketKind, string> = {
  SUPPORT: '技术支持',
  FEEDBACK: '意见反馈',
};

export const SUPPORT_STATUS_LABELS: Record<SupportTicketStatus, string> = {
  OPEN: '待处理',
  REPLIED: '已回复',
  CLOSED: '已关闭',
};

export const SUPPORT_STATUS_TONES: Record<SupportTicketStatus, BadgeTone> = {
  OPEN: 'warning',
  REPLIED: 'info',
  CLOSED: 'neutral',
};

export interface SupportUserRef {
  id: string;
  name: string;
}

export interface SupportTicketListItem {
  id: string;
  kind: SupportTicketKind;
  title: string;
  status: SupportTicketStatus;
  createdBy: SupportUserRef | null;
  createdAt: string;
  updatedAt: string;
  replyCount: number;
}

export interface SupportTicketManageItem extends SupportTicketListItem {
  tenantName: string | null;
}

export interface SupportTicketReply {
  id: string;
  content: string;
  author: SupportUserRef | null;
  /** 提交人自己追加的回复；否则是处理人的答复。 */
  byCreator: boolean;
  createdAt: string;
}

export interface SupportTicketDetail extends Omit<SupportTicketListItem, 'replyCount'> {
  content: string;
  replies: SupportTicketReply[];
}

export interface SupportTicketQuery {
  kind?: SupportTicketKind;
  status?: SupportTicketStatus;
  page?: number;
  pageSize?: number;
}

export const supportApi = {
  mine: (query: SupportTicketQuery) =>
    request<Paginated<SupportTicketListItem>>('GET', '/support-tickets', { query: { ...query } }),
  manage: (query: SupportTicketQuery) =>
    request<Paginated<SupportTicketManageItem>>('GET', '/support-tickets/manage', {
      query: { ...query },
    }),
  get: (id: string) =>
    request<SupportTicketDetail>('GET', `/support-tickets/${encodeURIComponent(id)}`),
  create: (body: { kind: SupportTicketKind; title: string; content: string }) =>
    request<SupportTicketDetail>('POST', '/support-tickets', { body }),
  reply: (id: string, content: string) =>
    request<SupportTicketDetail>('POST', `/support-tickets/${encodeURIComponent(id)}/replies`, {
      body: { content },
    }),
  close: (id: string) =>
    request<SupportTicketDetail>('POST', `/support-tickets/${encodeURIComponent(id)}/close`),
};
