import { Link } from 'react-router-dom';

/** 评估模型未配置：说明缺什么、去哪里配。 */
export function JudgeNotice({ message, path }: { message: string | null; path: string; unavailable?: boolean }) {
  const prefix = '判定模型当前不可用：';
  const rawReason = (message ?? '').replace(/^(判定模型当前不可用|未配置评估模型)[:：]?\s*/, '');
  const reason = /LLM_JUDGE|\{\{/.test(rawReason) ? '未配置' : rawReason.replace(/[。.!！]+$/, '');
  return (
    <div
      role="alert"
      className="rounded-lg border border-severity-critical bg-white px-4 py-2.5 text-sm text-slate-700"
    >
      <span className="text-severity-critical">{prefix}{reason || '未配置'}。</span>
      <Link to={path} className="ml-1 text-brand-600 hover:underline">
        去配置
      </Link>
    </div>
  );
}
