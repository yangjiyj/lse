import type { ReactNode } from 'react';
import {
  ACCELERATOR_ERROR_LABELS,
  ACCELERATOR_SOURCE_LABELS,
  ACCELERATOR_VENDOR_LABELS,
  AI_COMPONENT_CATEGORIES,
  AI_COMPONENT_CATEGORY_LABELS,
  AI_COMPONENT_ENV_LABELS,
  AI_COMPONENT_ERROR_LABELS,
  AI_COMPONENT_SOURCE_LABELS,
  type EndpointAIComponent,
  type EndpointHardware,
} from '../../../../../packages/shared/src/endpoint-hardware';
import { SectionCard } from '@/components/page-kit/SectionCard';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { osLabel } from '@/lib/endpoint-agents';

const DASH = '—';

function gb(mb: number): string {
  const value = mb / 1024;
  return `${value >= 100 ? Math.round(value) : Number(value.toFixed(1))} GB`;
}

function bytes(value: number): string {
  const tb = value / 1e12;
  if (tb >= 1) return `${Number(tb.toFixed(1))} TB`;
  return `${Number((value / 1e9).toFixed(1))} GB`;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="mt-1 break-words">{children}</dd>
    </div>
  );
}

/** 采集不完整时说明原因，免得把「—」或短列表当成「没有」。 */
function Incomplete({
  codes,
  labels,
}: {
  codes: string[] | null | undefined;
  labels: Record<string, string>;
}) {
  if (!codes?.length) return null;
  return (
    <p data-testid="incomplete" className="mb-2 text-xs text-ink-3">
      采集不完整：{codes.map((code) => labels[code] ?? code).join('；')}
    </p>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <SectionCard title={title}>{children}</SectionCard>
    </section>
  );
}

function HardwareCard({ hardware: h }: { hardware: EndpointHardware | null }) {
  const cores = [
    h?.cpuCores != null && `${h.cpuCores} 核`,
    h?.cpuCountLogical != null && `${h.cpuCountLogical} 线程`,
  ]
    .filter(Boolean)
    .join(' ');
  const system = h?.os
    ? [
        osLabel(h.os),
        h.osVersion || [h.platform, h.platformVersion].filter(Boolean).join(' '),
        h.arch,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  const accelerators = h?.accelerators ?? [];
  return (
    <Card title="硬件">
      <dl className="grid gap-4 text-sm sm:grid-cols-2 xl:grid-cols-5">
        <Field label="CPU">
          {h?.cpuModel ? [h.cpuModel, cores].filter(Boolean).join(' · ') : DASH}
        </Field>
        <Field label="内存">{h?.memoryTotalMB != null ? gb(h.memoryTotalMB) : DASH}</Field>
        <Field label="磁盘">
          {h?.disks?.length
            ? h.disks.map((d) => (
                <span key={d.mountpoint} className="block">
                  {[
                    d.mountpoint,
                    d.totalBytes != null && bytes(d.totalBytes),
                    d.usedPct != null && `已用 ${Math.round(d.usedPct)}%`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              ))
            : DASH}
        </Field>
        <Field label="系统">{system || DASH}</Field>
        <Field label="内核">{h?.kernelVersion || DASH}</Field>
      </dl>
      <h3 className="mb-2 mt-6 text-xs font-medium text-ink-3">算力卡</h3>
      <Incomplete codes={h?.acceleratorErrors} labels={ACCELERATOR_ERROR_LABELS} />
      {accelerators.length ? (
        <Table aria-label="算力卡">
          <THead>
            <TR>
              {['厂商', '型号', '显存', '驱动', '编号', '总线', '来源'].map((label) => (
                <TH key={label}>{label}</TH>
              ))}
            </TR>
          </THead>
          <TBody>
            {accelerators.map((a, i) => (
              <TR key={`${a.busId ?? ''}-${a.model}-${i}`}>
                <TD data-label="厂商">{ACCELERATOR_VENDOR_LABELS[a.vendor] ?? a.vendor}</TD>
                <TD data-label="型号">{a.model}</TD>
                <TD data-label="显存">{a.memoryMB != null ? gb(a.memoryMB) : DASH}</TD>
                <TD data-label="驱动">{a.driverVersion || DASH}</TD>
                <TD data-label="编号">{a.index ?? DASH}</TD>
                <TD data-label="总线">{a.busId || DASH}</TD>
                <TD data-label="来源">{ACCELERATOR_SOURCE_LABELS[a.source] ?? a.source}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : (
        <p data-testid="accelerators">{DASH}</p>
      )}
    </Card>
  );
}

function ComponentsCard({
  components,
  errors,
}: {
  components: EndpointAIComponent[] | null;
  errors: string[] | null;
}) {
  const known: readonly string[] = AI_COMPONENT_CATEGORIES;
  const categories = [
    ...known,
    ...[...new Set((components ?? []).map((c) => c.category))].filter((c) => !known.includes(c)),
  ];
  const groups = categories
    .map((category) => ({
      category,
      rows: (components ?? []).filter((c) => c.category === category),
    }))
    .filter((g) => g.rows.length);
  return (
    <Card title="框架与组件">
      <Incomplete codes={errors} labels={AI_COMPONENT_ERROR_LABELS} />
      {groups.length ? (
        <div className="space-y-6">
          {groups.map(({ category, rows }) => {
            const label = AI_COMPONENT_CATEGORY_LABELS[category] ?? category;
            return (
              <section key={category}>
                <h3 className="mb-2 text-xs font-medium text-ink-3">{label}</h3>
                <Table aria-label={label}>
                  <THead>
                    <TR>
                      {['名称', '版本', '来源', '环境'].map((h) => (
                        <TH key={h}>{h}</TH>
                      ))}
                    </TR>
                  </THead>
                  <TBody>
                    {rows.map((c, i) => (
                      <TR key={`${c.id}-${c.source}-${c.version ?? ''}-${c.env ?? ''}-${i}`}>
                        <TD data-label="名称">{c.name}</TD>
                        <TD data-label="版本">{c.version || DASH}</TD>
                        <TD data-label="来源" title={c.package}>
                          {AI_COMPONENT_SOURCE_LABELS[c.source] ?? c.source}
                        </TD>
                        <TD data-label="环境">
                          {c.env ? (AI_COMPONENT_ENV_LABELS[c.env] ?? c.env) : DASH}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </section>
            );
          })}
        </div>
      ) : (
        <p>{DASH}</p>
      )}
    </Card>
  );
}

/** 终端详情的硬件卡片与框架组件分组；旧探针缺的字段一律显示「—」。 */
export function EndpointHardwareCards({
  hardware,
}: {
  hardware: EndpointHardware | null | undefined;
}) {
  return (
    <div className="space-y-4">
      <HardwareCard hardware={hardware ?? null} />
      <ComponentsCard
        components={hardware?.aiComponents ?? null}
        errors={hardware?.aiComponentErrors ?? null}
      />
    </div>
  );
}
