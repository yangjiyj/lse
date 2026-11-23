import type { Severity } from '@prisma/client';

const SEVERITY_BY_NUMBER: Record<number, Severity> = {
  1: 'INFO',
  2: 'LOW',
  3: 'MEDIUM',
  4: 'HIGH',
  5: 'CRITICAL',
};

export function normalizeSeverity(value: unknown): Severity | null {
  if (typeof value === 'number') return SEVERITY_BY_NUMBER[value] ?? null;
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (['critical', '严重', '致命'].includes(normalized)) return 'CRITICAL';
  if (['high', '高', '高危'].includes(normalized)) return 'HIGH';
  if (['medium', 'moderate', '中', '中危'].includes(normalized)) return 'MEDIUM';
  if (['low', '低', '低危'].includes(normalized)) return 'LOW';
  if (['info', 'informational', '提示', '信息'].includes(normalized)) return 'INFO';
  return null;
}

export function normalizeLegacySeverity(value: unknown, fallback: Severity = 'MEDIUM'): Severity {
  return normalizeSeverity(value) ?? fallback;
}

export function clipText(value: unknown, maxLength = 2_000): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}…`;
}
