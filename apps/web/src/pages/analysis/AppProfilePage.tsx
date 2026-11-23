import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  DETECT_CATEGORIES,
  DETECT_CATEGORY_LABELS,
  LEDGER_ATTR_FIELDS,
  type DetectCategory,
} from '@lse/shared';
import {
  ACCELERATOR_VENDOR_LABELS,
  AI_COMPONENT_CATEGORY_LABELS,
} from '../../../../../packages/shared/src/endpoint-hardware';
import { PageHeader } from '@/components/PageHeader';
import { QueryState } from '@/components/QueryState';
import { detectResultsHref } from '@/components/dashboard/drill';
import { SectionCard } from '@/components/page-kit/SectionCard';
import { Badge } from '@/components/ui/badge';
import { SeverityBadge } from '@/components/ui/severity-badge';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { formatDate, formatEvalScore, formatNumber } from '@/lib/format';
import { ledgerAttrText } from '@/lib/ledger';
import { useTenantView } from '@/lib/tenant-view';
import {
  DISCOVERY_TRUNCATED_HINT,
  RISK_SEVERITY_LABELS,
  corpusTruncatedHint,
  appProfilesApi,
  type AppProfile,
  type DetectRiskCategoryStat,
  type RiskSeverityKey,
} from '@/lib/detect-risks';
import { ResultRow } from './DetectResultsPage';

const DASH = '—';

function gb(mb: number): string {
  const value = mb / 1024;
  return `${value >= 100 ? Math.round(value) : Number(value.toFixed(1))} GB`;
}

/** 画像的一块：区块标题即无障碍名称。 */
function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <SectionCard title={title}>{children}</SectionCard>
    </section>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="mt-1 break-words text-sm text-ink">{children || DASH}</dd>
    </div>
  );
}

function SubTitle({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 mt-5 text-xs font-medium text-ink-3 first:mt-0">{children}</h3>;
}

function Severity({ value }: { value: RiskSeverityKey }) {
  return value === 'UNRATED' ? (
    <Badge tone="neutral">{RISK_SEVERITY_LABELS.UNRATED}</Badge>
  ) : (
    <SeverityBadge value={value} />
  );
}

/** 受测应用安全画像（2.5.6）：基础信息、环境、算力、模型、风险、处置建议。 */
export function AppProfilePage() {
  const { assetId = '' } = useParams();
  const profile = useQuery({
    queryKey: ['app-profile', assetId],
    queryFn: () => appProfilesApi.get(assetId),
  });
  const p = profile.data;
  if (!p) {
    return (
      <QueryState
        isLoading={profile.isLoading}
        isError={profile.isError}
        error={profile.error}
        onRetry={() => void profile.refetch()}
        empty={!profile.isLoading && !profile.isError}
        emptyTitle="应用平台不存在"
        emptyDescription=""
      />
    );
  }
  return (
    <div className="space-y-4">
      <PageHeader title={p.asset.name} />
      {p.truncated && (
        <p className="text-[13px] text-severity-high">关联资产过多，只统计前 200 个</p>
      )}
      <BasicBlock asset={p.asset} />
      <EnvironmentBlock environment={p.environment} />
      <ComputeBlock compute={p.compute} />
      <ModelsBlock models={p.models} tenantId={p.asset.tenantId} />
      <RisksBlock risks={p.risks} profileId={p.asset.id} />
      <SuggestionsBlock suggestions={p.suggestions} />
    </div>
  );
}

function BasicBlock({ asset }: { asset: AppProfile['asset'] }) {
  return (
    <Block title="基础信息">
      <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Item label="编号">{asset.code}</Item>
        <Item label="组织">{asset.organizationPath}</Item>
        <Item label="责任人">{asset.ownerName}</Item>
        <Item label="责任部门">{asset.ownerDepartment}</Item>
        <Item label="评估对象">{asset.modelTarget?.name}</Item>
        {LEDGER_ATTR_FIELDS.platform.map((f) => (
          <Item key={f.key} label={f.label}>
            {ledgerAttrText('platform', f.key, asset.attrs[f.key])}
          </Item>
        ))}
      </dl>
      {asset.description && (
        <p className="mt-4 whitespace-pre-wrap text-sm text-ink-2">{asset.description}</p>
      )}
    </Block>
  );
}

function EnvironmentBlock({ environment }: { environment: AppProfile['environment'] }) {
  const { servers, software, components, frameworks } = environment;
  return (
    <Block title="环境">
      <SubTitle>服务器</SubTitle>
      {servers.length ? (
        <Table aria-label="服务器">
          <THead>
            <TR>
              {['名称', 'IP', '终端', '操作系统', 'CPU', '内存', 'GPU'].map((label) => (
                <TH key={label}>{label}</TH>
              ))}
            </TR>
          </THead>
          <TBody>
            {/* 规格由接口合好：终端探针上报的优先，探针没有的项用台账里填的。 */}
            {servers.map((s) => (
              <TR key={s.assetId}>
                <TD data-label="名称">{s.name}</TD>
                <TD data-label="IP">{s.ip ?? DASH}</TD>
                <TD data-label="终端">{s.endpoint?.hostname ?? DASH}</TD>
                <TD data-label="操作系统">{s.os ?? DASH}</TD>
                <TD data-label="CPU">{s.cpu ?? DASH}</TD>
                <TD data-label="内存">{s.memoryMB ? gb(s.memoryMB) : DASH}</TD>
                <TD data-label="GPU">{s.gpu ?? DASH}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : (
        <p className="text-sm text-ink-3">{DASH}</p>
      )}
      <SubTitle>软件</SubTitle>
      <InlineList
        items={software.map((s) => ({
          key: s.assetId,
          text: [s.name, s.vendor, s.version].filter(Boolean).join(' '),
        }))}
      />
      <SubTitle>组件</SubTitle>
      <InlineList
        items={components.map((c) => ({
          key: c.assetId,
          text: [
            c.name,
            c.componentType ? ledgerAttrText('component', 'componentType', c.componentType) : '',
            c.version,
          ]
            .filter(Boolean)
            .join(' '),
        }))}
      />
      {/* 终端探针在服务器上识别出的框架；和台账组件类型「训练推理框架」区分开，没有时整块不显示。 */}
      {frameworks.length > 0 && (
        <>
          <SubTitle>服务器上的 AI 框架</SubTitle>
          <InlineList
            items={frameworks.map((f) => ({
              key: `${f.id}|${f.version ?? ''}`,
              text: [f.name, f.version].filter(Boolean).join(' '),
              title: AI_COMPONENT_CATEGORY_LABELS[f.category] ?? f.category,
            }))}
          />
        </>
      )}
    </Block>
  );
}

function InlineList({ items }: { items: Array<{ key: string; text: string; title?: string }> }) {
  if (items.length === 0) return <p className="text-sm text-ink-3">{DASH}</p>;
  return (
    <ul className="flex flex-wrap gap-2">
      {items.map((i) => (
        <li
          key={i.key}
          title={i.title}
          className="rounded-lg border border-line bg-canvas px-2.5 py-1 text-[13px] text-ink-2"
        >
          {i.text}
        </li>
      ))}
    </ul>
  );
}

type Accelerator = AppProfile['compute']['accelerators'][number];

/** 型号去掉开头的厂商名、末尾的显存（两样都单独成列）；去完是空的就用原值。 */
export function acceleratorModel(a: Pick<Accelerator, 'vendor' | 'model' | 'memoryMB'>): string {
  let model = a.model.trim();
  for (const name of [ACCELERATOR_VENDOR_LABELS[a.vendor], a.vendor]) {
    if (!name || !model.toLowerCase().startsWith(name.toLowerCase())) continue;
    const rest = model.slice(name.length);
    if (/^[\s-]/.test(rest)) {
      model = rest.replace(/^[\s-]+/, '');
      break;
    }
  }
  if (a.memoryMB != null) model = model.replace(/[\s-]+\d+(?:\.\d+)?\s*(?:GB|GiB|G)$/i, '');
  return model || a.model;
}

/** 同一台服务器上厂商、型号、显存、驱动都相同的卡并成一行，带张数。 */
export function groupAccelerators(
  cards: Accelerator[],
): Array<Accelerator & { key: string; count: number }> {
  const rows = new Map<string, Accelerator & { key: string; count: number }>();
  for (const card of cards) {
    const model = acceleratorModel(card);
    const key = JSON.stringify([
      card.serverName,
      card.vendor,
      model,
      card.memoryMB ?? null,
      card.driverVersion || null,
    ]);
    const row = rows.get(key);
    if (row) row.count += 1;
    else rows.set(key, { ...card, model, key, count: 1 });
  }
  return [...rows.values()];
}

function ComputeBlock({ compute }: { compute: AppProfile['compute'] }) {
  if (compute.cardCount === 0) {
    return (
      <Block title="算力">
        <p className="text-sm text-ink-3">{DASH}</p>
      </Block>
    );
  }
  return (
    <Block title="算力">
      <Table aria-label="算力卡">
        <THead>
          <TR>
            {['厂商', '型号', '显存', '驱动', '数量', '所在服务器'].map((label) => (
              <TH key={label}>{label}</TH>
            ))}
          </TR>
        </THead>
        <TBody>
          {groupAccelerators(compute.accelerators).map((a) => (
            <TR key={a.key}>
              <TD data-label="厂商">{ACCELERATOR_VENDOR_LABELS[a.vendor] ?? a.vendor}</TD>
              <TD data-label="型号">{a.model}</TD>
              <TD data-label="显存">{a.memoryMB != null ? gb(a.memoryMB) : DASH}</TD>
              <TD data-label="驱动">{a.driverVersion || DASH}</TD>
              <TD data-label="数量" className="tabular-nums">
                {a.count}
              </TD>
              <TD data-label="所在服务器">{a.serverName}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
      <p className="mt-3 text-[13px] text-ink-2">
        {compute.totalMemoryMB != null
          ? `共 ${formatNumber(compute.cardCount)} 张，显存 ${gb(compute.totalMemoryMB)}`
          : `共 ${formatNumber(compute.cardCount)} 张`}
      </p>
    </Block>
  );
}

function ModelsBlock({
  models,
  tenantId,
}: {
  models: AppProfile['models'];
  tenantId: string | null;
}) {
  const { guardRow } = useTenantView();
  return (
    <Block title="模型">
      {models.length === 0 ? (
        <p className="text-sm text-ink-3">{DASH}</p>
      ) : (
        <Table aria-label="模型">
          <THead>
            <TR>
              {['模型', '识别结论', '量化', '基座模型', '已知模型', '最近评估'].map((label) => (
                <TH key={label}>{label}</TH>
              ))}
            </TR>
          </THead>
          <TBody>
            {models.map((m) => (
              <TR key={m.assetId}>
                <TD data-label="模型">{m.name}</TD>
                <TD data-label="识别结论">{m.identity?.verdictLabel ?? DASH}</TD>
                <TD data-label="量化">{m.identity?.quantization ?? DASH}</TD>
                <TD data-label="基座模型">{m.baseModel ?? DASH}</TD>
                <TD data-label="已知模型">{m.identity?.knownModel ?? DASH}</TD>
                <TD data-label="最近评估">
                  {m.lastEval ? (
                    <Link
                      to={`/eval-tasks/${encodeURIComponent(m.lastEval.taskId)}`}
                      onClick={(ev) => {
                        if (guardRow(tenantId, `/eval-tasks/${m.lastEval!.taskId}`)) {
                          ev.preventDefault();
                        }
                      }}
                      className="text-brand-600 hover:underline"
                    >
                      {m.lastEval.score != null
                        ? `${formatEvalScore(m.lastEval.score)} 分 · ${formatDate(m.lastEval.finishedAt)}`
                        : formatDate(m.lastEval.finishedAt)}
                    </Link>
                  ) : (
                    DASH
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Block>
  );
}

function RiskCell({ stat, profileId }: { stat: DetectRiskCategoryStat; profileId: string }) {
  const visible = stat.sources.filter((s) => s.count);
  const cell = 'flex min-w-0 flex-col rounded-xl bg-canvas p-3.5';
  if (visible.length === 0) {
    return (
      <div className={cell}>
        <div className="text-[13px] font-medium text-ink-2">{stat.label}</div>
        <div className="mt-1 font-num text-[24px] font-bold leading-8 text-ink-3">{DASH}</div>
      </div>
    );
  }
  // 点卡片跳检测结果页，带有风险的第一个来源（都没有时带第一个可见来源）。
  const source = (visible.find((s) => s.count!.total > 0) ?? visible[0]!).source;
  return (
    <Link
      to={detectResultsHref({ category: stat.category, source, profile: profileId })}
      className={`${cell} group hover:ring-1 hover:ring-brand-200`}
    >
      <span className="text-[13px] font-medium text-ink-2 group-hover:text-brand-700">
        {stat.label}
      </span>
      <span className="mt-1 flex items-baseline gap-2">
        <span className="font-num text-[24px] font-bold leading-8 tabular-nums text-ink">
          {formatNumber(stat.total)}
        </span>
        <span
          className={`text-[12.5px] ${stat.high > 0 ? 'font-medium text-severity-high' : 'text-ink-3'}`}
        >
          {`高危 ${formatNumber(stat.high)}`}
        </span>
      </span>
    </Link>
  );
}

function RisksBlock({ risks, profileId }: { risks: AppProfile['risks']; profileId: string }) {
  const { isAllTenants, tenantName, guardRow } = useTenantView();
  const hints = [
    risks.stats.truncatedCorpusScans > 0
      ? corpusTruncatedHint(risks.stats.truncatedCorpusScans)
      : null,
    risks.stats.discoveryRunsTruncated ? DISCOVERY_TRUNCATED_HINT : null,
  ].filter((h): h is string => Boolean(h));
  return (
    <Block title="风险">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {risks.stats.categories.map((c) => (
          <RiskCell key={c.category} stat={c} profileId={profileId} />
        ))}
      </div>
      {hints.map((h) => (
        <p key={h} className="mt-2 text-[13px] text-severity-high">
          {h}
        </p>
      ))}
      <SubTitle>主要风险</SubTitle>
      {risks.top.length === 0 ? (
        <p className="text-sm text-ink-3">{DASH}</p>
      ) : (
        <Table aria-label="主要风险">
          <THead>
            <TR>
              <TH>风险</TH>
              <TH>严重度</TH>
              <TH>对象</TH>
              <TH>来源记录</TH>
              {isAllTenants && <TH>租户</TH>}
              <TH>时间</TH>
            </TR>
          </THead>
          <TBody>
            {risks.top.map((r) => (
              <ResultRow
                key={`${r.source}:${r.id}`}
                row={r}
                tenant={isAllTenants ? tenantName(r.tenantId) : null}
                onOpen={(ev) => {
                  if (guardRow(r.tenantId, r.href)) ev.preventDefault();
                }}
              />
            ))}
          </TBody>
        </Table>
      )}
    </Block>
  );
}

function SuggestionsBlock({ suggestions }: { suggestions: AppProfile['suggestions'] }) {
  const groups = DETECT_CATEGORIES.map((category) => ({
    category,
    items: suggestions.filter((s) => s.category === category),
  })).filter((g) => g.items.length > 0);
  return (
    <Block title="处置建议">
      {groups.length === 0 ? (
        <p className="text-sm text-ink-3">{DASH}</p>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <SuggestionGroup key={g.category} category={g.category} items={g.items} />
          ))}
        </div>
      )}
    </Block>
  );
}

function SuggestionGroup({
  category,
  items,
}: {
  category: DetectCategory;
  items: AppProfile['suggestions'];
}) {
  const label = DETECT_CATEGORY_LABELS[category];
  return (
    <div role="group" aria-label={label}>
      <h3 className="mb-2 text-[13px] font-semibold text-ink">{label}</h3>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {items.map((s) => (
          <li key={`${s.source}:${s.title}`} className="flex flex-col gap-1 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Severity value={s.severity} />
              <span className="text-sm font-medium text-ink">{s.title}</span>
              <span className="text-xs text-ink-3">{`${formatNumber(s.count)} 条`}</span>
            </div>
            <p className="text-[13px] leading-5 text-ink-2">{s.action || DASH}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
