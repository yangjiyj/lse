import { Badge } from './badge';
import { SeverityBadge } from './severity-badge';
import {
  IMPORT_STATUS_LABELS,
  IMPORT_STATUS_TONE,
  LICENSE_STATUS_LABELS,
  LICENSE_STATUS_TONE,
  MODEL_CALL_STATUS_LABELS,
  MODEL_CALL_STATUS_TONE,
  TASK_STATUS_LABELS,
  TASK_STATUS_TONE,
  VERDICT_LABELS,
  VERDICT_TONE,
} from '@/lib/format';
import type { BadgeTone } from '@/lib/format';

function pick<T extends string>(
  map: Record<T, string>,
  tones: Record<T, BadgeTone>,
  key: string | null | undefined,
): { label: string; tone: BadgeTone } {
  if (key && key in map) {
    return { label: map[key as T], tone: tones[key as T] };
  }
  return { label: key ?? '—', tone: 'neutral' };
}

export { SeverityBadge };

export function VerdictBadge({ value }: { value: string | null | undefined }) {
  const { label, tone } = pick(VERDICT_LABELS, VERDICT_TONE, value);
  return (
    <Badge tone={tone} icon>
      {label}
    </Badge>
  );
}

export function TaskStatusBadge({ value }: { value: string | null | undefined }) {
  const { label, tone } = pick(TASK_STATUS_LABELS, TASK_STATUS_TONE, value);
  return (
    <Badge tone={tone} icon>
      {label}
    </Badge>
  );
}

export function ModelCallStatusBadge({ value }: { value: string | null | undefined }) {
  const { label, tone } = pick(MODEL_CALL_STATUS_LABELS, MODEL_CALL_STATUS_TONE, value);
  return (
    <Badge tone={tone} icon>
      {label}
    </Badge>
  );
}

export function ImportStatusBadge({ value }: { value: string | null | undefined }) {
  const { label, tone } = pick(IMPORT_STATUS_LABELS, IMPORT_STATUS_TONE, value);
  return (
    <Badge tone={tone} icon>
      {label}
    </Badge>
  );
}

export function LicenseStatusBadge({ value }: { value: string | null | undefined }) {
  const { label, tone } = pick(LICENSE_STATUS_LABELS, LICENSE_STATUS_TONE, value);
  return (
    <Badge tone={tone} icon>
      {label}
    </Badge>
  );
}
