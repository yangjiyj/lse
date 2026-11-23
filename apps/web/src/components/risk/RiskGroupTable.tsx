import type { RiskGroup } from '@/lib/api';
import { useTenantView } from '@/lib/tenant-view';
import { RiskSeverityBadge } from './RiskSeverityBadge';
import { riskDate } from './risk-date';

export function RiskGroupTable({ items, selectedId, onSelect }: {
  items: RiskGroup[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { isAllTenants, tenantName, guardRow } = useTenantView();
  const select = (item: RiskGroup) => {
    if (!guardRow(item.tenantId, '/wrong-answers')) onSelect(item.id);
  };
  return <div className="overflow-x-auto rounded-xl border border-line bg-white">
    <table className="w-full min-w-[590px] table-fixed text-left text-[13px]">
      <colgroup><col style={{ width: 72 }} /><col /><col style={{ width: 112 }} /><col style={{ width: 132 }} /><col style={{ width: 76 }} />{isAllTenants && <col style={{ width: 110 }} />}</colgroup>
      <thead className="border-b border-line bg-[#F8FAFD] text-xs font-medium text-ink-3"><tr>
        {['等级', '问题', '评估对象', '样本数', '发现日期'].map(title => <th key={title} className="h-10 px-3 font-medium whitespace-nowrap">{title}</th>)}
        {isAllTenants && <th className="h-10 px-3 font-medium whitespace-nowrap">租户</th>}
      </tr></thead>
      <tbody>{items.map(item => <tr key={item.id} onClick={() => select(item)}
        className={`h-12 cursor-pointer border-b border-line last:border-0 hover:bg-[#F7F9FD] ${selectedId === item.id ? 'bg-[#EEF3FF] shadow-[inset_3px_0_0_#1F57E0]' : ''}`}>
        <td className="px-3 py-3"><RiskSeverityBadge value={item.severity} /></td>
        <td className="px-3 py-3"><button type="button" className="w-full break-words text-left leading-5 text-ink hover:text-primary focus-visible:outline-primary"
          onClick={event => { event.stopPropagation(); select(item); }}>{item.title}</button></td>
        <td className="truncate px-3 py-3 text-ink-2" title={item.targets.names.join('、')}>
          {item.targets.count > 1 ? `${item.targets.count} 个对象` : item.targets.names[0] ?? '未命名对象'}
        </td>
        <td className="px-3 py-3 tabular-nums text-ink"><span>{item.sampleCount}</span>{item.suspectedFalsePositive > 0 &&
          <span className="ml-1.5 inline-block whitespace-nowrap rounded bg-[#FFF6D6] px-1.5 py-0.5 text-[11px] text-[#8A5F00]">{item.suspectedFalsePositive} 疑似误报</span>}</td>
        <td className="whitespace-nowrap px-3 py-3 tabular-nums text-ink-2">{riskDate(item.latestAt, true)}</td>
        {isAllTenants && <td className="truncate px-3 py-3 text-ink-2" data-testid="tenant-cell">{tenantName(item.tenantId)}</td>}
      </tr>)}</tbody>
    </table>
  </div>;
}
