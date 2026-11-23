import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { modelFilesApi, type ModelFileRule } from '@/lib/api';
import { severityLabel } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';

/** 模型文件扫描的检测规则数，点开按类别列出检测规则，解析和扫描过程的提示单独列在最后。 */
export function RuleCatalog() {
  const [open, setOpen] = useState(false);
  const rules = useQuery({
    queryKey: ['model-files', 'rules'],
    queryFn: () => modelFilesApi.rules(),
    staleTime: Infinity,
  });
  if (!rules.data) return null;
  const groups = new Map<string, ModelFileRule[]>();
  const notes: ModelFileRule[] = [];
  for (const r of rules.data.items)
    if (r.kind === 'note') notes.push(r);
    else groups.set(r.category, [...(groups.get(r.category) ?? []), r]);
  if (notes.length) groups.set('提示', notes);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        检测规则 {rules.data.detectTotal} 条
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="检测规则" size="xl">
        <div className="max-h-[70vh] space-y-4 overflow-y-auto">
          {[...groups].map(([category, items]) => (
            <div key={category} role="group" aria-label={category} className="space-y-2">
              <div className="text-sm font-medium">
                {category}{' '}
                <span className="tabular-nums text-muted-foreground">{items.length}</span>
              </div>
              <Table>
                <THead>
                  <TR>
                    <TH>规则</TH>
                    <TH>严重度</TH>
                    <TH>名称</TH>
                    <TH>说明</TH>
                  </TR>
                </THead>
                <TBody>
                  {items.map((r) => (
                    <TR key={r.id}>
                      <TD className="font-mono text-xs">{r.id}</TD>
                      <TD>{severityLabel(r.severity)}</TD>
                      <TD>{r.title}</TD>
                      <TD className="text-xs">{r.description}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          ))}
        </div>
      </Modal>
    </>
  );
}
