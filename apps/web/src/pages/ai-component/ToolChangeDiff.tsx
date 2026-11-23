import type { ReactNode } from 'react';
import { canonicalJson, lineDiff, type DiffLine } from './line-diff';

export interface ToolSnapshot {
  description: string | null;
  inputSchema: unknown;
  annotations: unknown;
}

const LINE_STYLE: Record<DiffLine['type'], { cls: string; mark: string; testId: string }> = {
  add: { cls: 'bg-severity-pass/10 text-slate-900', mark: '+', testId: 'diff-add' },
  del: { cls: 'bg-severity-critical/10 text-slate-900', mark: '-', testId: 'diff-del' },
  same: { cls: 'text-slate-600', mark: ' ', testId: 'diff-same' },
};

function Lines({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="max-h-72 overflow-auto rounded-lg border border-slate-200 bg-white py-1 font-mono text-xs leading-5">
      {lines.map((l, i) => (
        <div
          key={i}
          data-testid={LINE_STYLE[l.type].testId}
          className={`whitespace-pre-wrap break-all px-2 ${LINE_STYLE[l.type].cls}`}
        >
          <span className="mr-2 select-none text-slate-500">{LINE_STYLE[l.type].mark}</span>
          {l.text}
        </div>
      ))}
    </pre>
  );
}

function Field({
  label,
  before,
  after,
  note,
}: {
  label: string;
  before: string;
  after: string;
  note?: ReactNode;
}) {
  const changed = before !== after;
  const head = (
    <>
      <span className="font-medium text-slate-800">{label}</span>
      <span className={`ml-2 ${changed ? 'text-severity-high' : 'text-slate-500'}`}>
        {changed ? '有变化' : '无变化'}
      </span>
    </>
  );
  return (
    <div role="group" aria-label={label} className="text-xs">
      {note ? (
        <div className="space-y-1">
          <div>{head}</div>
          <p className="text-slate-600">{note}</p>
          <Lines lines={after.split('\n').map((text) => ({ type: 'same' as const, text }))} />
        </div>
      ) : changed ? (
        <div className="space-y-1">
          <div>{head}</div>
          <Lines lines={lineDiff(before, after)} />
        </div>
      ) : (
        <details>
          <summary className="cursor-pointer">{head}</summary>
          <Lines lines={after.split('\n').map((text) => ({ type: 'same' as const, text }))} />
        </details>
      )}
    </div>
  );
}

/** rug pull 工具变更的逐字段对比：描述、参数定义、注解；有变化的字段做行级 diff，无变化的折叠。 */
export function ToolChangeDiff({
  baseline,
  current,
}: {
  baseline: ToolSnapshot & { inputSchemaRecorded: boolean };
  current: ToolSnapshot;
}) {
  return (
    <div className="space-y-2">
      <Field
        label="工具描述"
        before={baseline.description ?? ''}
        after={current.description ?? ''}
      />
      <Field
        label="参数定义（inputSchema）"
        before={canonicalJson(baseline.inputSchema)}
        after={canonicalJson(current.inputSchema)}
        note={
          baseline.inputSchemaRecorded
            ? undefined
            : '基线建立时未记录参数定义（早期版本只保存了描述与哈希），无法逐行对比；以下为当前参数定义。确认为新基线后即可开始逐字段对比。'
        }
      />
      <Field
        label="工具注解（annotations）"
        before={canonicalJson(baseline.annotations)}
        after={canonicalJson(current.annotations)}
      />
    </div>
  );
}
