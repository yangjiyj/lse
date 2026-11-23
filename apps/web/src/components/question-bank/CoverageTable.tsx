import type { ReactNode } from 'react';
import type { BankCoverageRow } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';

/** 覆盖行状态：达标 / 需导入（只靠导入的小项）/ 还差多少。 */
export function CoverageStatus({ row }: { row: BankCoverageRow }) {
  if (row.ok) return <Badge tone="success">达标</Badge>;
  if (row.importOnly) return <Badge tone="neutral">需导入</Badge>;
  return <Badge tone="danger">还差 {row.gap.toLocaleString('zh-CN')}</Badge>;
}

/** 一张覆盖表：每行一个小项或方面，列出现有数量、要求与状态。 */
export function CoverageTable({
  rows,
  firstColumn,
  unit,
  extraHeader,
  extra,
}: {
  rows: BankCoverageRow[];
  firstColumn: string;
  unit: string;
  /** 追加一列（例如状态与操作）。 */
  extraHeader?: string;
  extra?: (row: BankCoverageRow) => ReactNode;
}) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>{firstColumn}</TH>
          <TH className="text-right">现有（{unit}）</TH>
          <TH className="text-right">要求不少于</TH>
          <TH>状态</TH>
          {extra && <TH>{extraHeader}</TH>}
        </TR>
      </THead>
      <TBody>
        {rows.map((r) => (
          <TR key={r.key}>
            <TD data-label={firstColumn}>{r.label}</TD>
            <TD data-label="现有" className="text-right tabular-nums">
              {r.count.toLocaleString('zh-CN')}
            </TD>
            <TD data-label="要求" className="text-right tabular-nums">
              {r.min > 0 ? r.min.toLocaleString('zh-CN') : '—'}
            </TD>
            <TD data-label="状态">
              {r.min > 0 ? (
                <CoverageStatus row={r} />
              ) : r.count > 0 ? (
                <Badge tone="success">已覆盖</Badge>
              ) : (
                <span className="text-ink-3">—</span>
              )}
            </TD>
            {extra && <TD data-label={extraHeader}>{extra(r)}</TD>}
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
