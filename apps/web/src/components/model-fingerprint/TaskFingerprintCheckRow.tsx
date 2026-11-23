import { Link } from 'react-router-dom';
import type { EvalTaskFingerprintCheck } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { formatSimilarity } from './TargetFingerprintSection';

/** 任务详情页「模型指纹前置比对」一行；无比对结果时不渲染。 */
export function TaskFingerprintCheckRow({
  check,
}: {
  check: EvalTaskFingerprintCheck | null | undefined;
}) {
  if (!check) return null;
  let body;
  switch (check.status) {
    case 'OK':
      body = <span>一致，相似度 {formatSimilarity(check.similarity)}</span>;
      break;
    case 'DRIFT':
      body = (
        <>
          <span className="text-severity-critical">
            疑似模型被替换，相似度 {formatSimilarity(check.similarity)}，低于阈值{' '}
            {formatSimilarity(check.threshold)}
          </span>
          <span className="text-xs text-muted-foreground">
            基线指纹 {check.baselineId ?? '—'}，可在
            <Link to="/model-targets" className="mx-0.5 text-brand-600 hover:underline">
              评估对象
            </Link>
            页「模型指纹」中查看
          </span>
        </>
      );
      break;
    case 'FAILED':
      body = <span>比对未完成：{check.reason || '未知原因'}（不影响任务执行）</span>;
      break;
    case 'NO_BASELINE':
      body = <span>未设基线</span>;
      break;
    default:
      return null;
  }
  return (
    <section
      aria-label="模型指纹前置比对"
      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-card border border-[#EDF1F8] bg-white px-5 py-3 text-sm shadow-card"
    >
      <span className="font-medium">模型指纹前置比对</span>
      {body}
      {check.checkedAt && (
        <span className="text-xs text-muted-foreground">{formatDateTime(check.checkedAt)}</span>
      )}
      <span className="text-xs text-muted-foreground">平台内部指纹比对，非模型身份认证结论</span>
    </section>
  );
}
