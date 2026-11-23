import type { RagItemType } from '@/lib/api';
import type { BadgeTone } from '@/lib/format';

export const RAG_QUALITY_TYPES = ['FACT', 'MULTI_HOP', 'NO_ANSWER', 'DISTRACTOR'] as const;
export const RAG_SECURITY_TYPES = ['POISON', 'INDIRECT_INJECTION', 'CROSS_ACCESS'] as const;

export const RAG_TYPE_LABEL: Record<RagItemType, string> = {
  FACT: '事实题',
  MULTI_HOP: '多跳题',
  NO_ANSWER: '无答案题',
  DISTRACTOR: '干扰题',
  POISON: '文档投毒',
  INDIRECT_INJECTION: '间接提示词注入',
  CROSS_ACCESS: '越权读取其他文档',
};

export function ragTypeLabel(type: string): string {
  return RAG_TYPE_LABEL[type as RagItemType] ?? type;
}

export const RAG_VERDICT: Record<string, { label: string; tone: BadgeTone }> = {
  PASS: { label: '通过', tone: 'success' },
  FAIL: { label: '未通过', tone: 'danger' },
  UNKNOWN: { label: '无法判定', tone: 'neutral' },
  ERROR: { label: '出错', tone: 'warning' },
};

export const RAG_RUN_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  PENDING: { label: '排队中', tone: 'neutral' },
  RUNNING: { label: '运行中', tone: 'info' },
  COMPLETED: { label: '已完成', tone: 'success' },
  FAILED: { label: '失败', tone: 'danger' },
  CANCELED: { label: '已取消', tone: 'neutral' },
};

export const RAG_CITATION_NOT_SUPPORTED = '该对象接口未返回引用来源，未评估';

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 读取本地文件为 base64（不含 data: 前缀）。 */
export function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result ?? '');
      resolve(s.slice(s.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

export const linkButton =
  'text-[13px] text-primary hover:underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline';
export const dangerLink =
  'text-[13px] text-[#B42318] hover:underline disabled:cursor-not-allowed disabled:text-slate-400';
