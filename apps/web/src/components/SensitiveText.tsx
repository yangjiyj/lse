import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { api } from '@/lib/api';
import { useDataSecurity } from '@/lib/data-security';
import {
  maskSensitiveText,
  maskValue,
  SENSITIVE_KIND_LABELS,
  type SensitiveKind,
} from '@/lib/sensitive';

interface RevealTarget {
  /** 页面/字段标识，写入审计，如 users.email。 */
  field: string;
  targetType?: string;
  targetId?: string;
}

function useReveal(target: RevealTarget, kind: SensitiveKind) {
  const [plain, setPlain] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = async () => {
    if (plain) {
      setPlain(false);
      return;
    }
    setPending(true);
    setError(null);
    try {
      // 先写审计再展示明文；审计失败则不展示。
      await api.dataSecurity.reveal({ kind, ...target });
      setPlain(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : '查看明文失败');
    } finally {
      setPending(false);
    }
  };
  return { plain, pending, error, toggle };
}

function RevealButton({
  plain,
  pending,
  onClick,
}: {
  plain: boolean;
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className="ml-1 inline-flex items-center gap-0.5 align-middle text-xs text-primary hover:underline disabled:opacity-50"
    >
      {plain ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
      {plain ? '隐藏' : '查看明文'}
    </button>
  );
}

/** 单个敏感字段（手机号/身份证号/邮箱/银行卡号/姓名），默认脱敏。 */
export function SensitiveValue({
  kind,
  value,
  ...target
}: RevealTarget & { kind: SensitiveKind; value: string | null | undefined }) {
  const ds = useDataSecurity();
  const reveal = useReveal(target, kind);
  if (!value) return <>—</>;
  if (!ds.maskSensitive) return <>{value}</>;
  return (
    <span title={reveal.error ?? `${SENSITIVE_KIND_LABELS[kind]}已脱敏`}>
      <span data-testid="sensitive-value">{reveal.plain ? value : maskValue(kind, value)}</span>
      {ds.canViewPlain ? (
        <RevealButton plain={reveal.plain} pending={reveal.pending} onClick={reveal.toggle} />
      ) : null}
    </span>
  );
}

/** 自由文本（测试样本、模型回答）：识别其中的手机号/身份证号/银行卡号/邮箱并默认脱敏。 */
export function SensitiveText({ text, ...target }: RevealTarget & { text: string }) {
  const ds = useDataSecurity();
  const masked = maskSensitiveText(text);
  const reveal = useReveal(target, masked.kinds[0] ?? 'phone');
  if (!ds.maskSensitive || masked.kinds.length === 0) return <>{text}</>;
  return (
    <>
      {reveal.plain ? text : masked.text}
      <span className="mt-1 block text-xs text-muted-foreground">
        已脱敏：{masked.kinds.map((k) => SENSITIVE_KIND_LABELS[k]).join('、')}
        {ds.canViewPlain ? (
          <RevealButton plain={reveal.plain} pending={reveal.pending} onClick={reveal.toggle} />
        ) : null}
        {reveal.error ? <span className="ml-1 text-destructive">{reveal.error}</span> : null}
      </span>
    </>
  );
}
