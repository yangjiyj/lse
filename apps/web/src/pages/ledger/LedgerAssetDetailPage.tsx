import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  LEDGER_ASSET_TYPE_LABELS,
  LEDGER_ATTR_FIELDS,
  LEDGER_ENDPOINT_LINK_TYPES,
  LEDGER_RELATION_LABELS,
  type LedgerAssetType,
  type LedgerRelationKind,
} from '@lse/shared';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import {
  LEDGER_QUERY_KEY,
  ledgerApi,
  ledgerAttrText,
  relationKindsFrom,
  relationTargetTypes,
  type LedgerAssetDetail,
  type LedgerRelationView,
} from '@/lib/ledger';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/page-kit/SectionCard';
import { EndpointHardwareCards } from '@/components/fleet/EndpointHardwareCards';
import { Button, buttonVariants } from '@/components/ui/button';
import { LoadingBlock } from '@/components/ui/spinner';
import { Select } from '@/components/ui/select';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { LedgerAssetModal } from './LedgerAssetModal';
import { QuickJobModal } from './QuickJobModal';
import { DetectJobItemStatusBadge } from '@/pages/detect-tasks/DetectStatusBadge';
import { SearchSelect, type SearchOption } from './SearchSelect';

const DASH = '—';

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="mt-1 break-words text-sm text-ink">{children || DASH}</dd>
    </div>
  );
}

/** 添加关系：先选关系，目标类型只列 LEDGER_RELATION_RULES 允许的，再选该类型的资产。 */
function AddRelation({ asset, onAdded }: { asset: LedgerAssetDetail; onAdded: () => void }) {
  const kinds = relationKindsFrom(asset.type);
  const [kind, setKind] = useState<LedgerRelationKind | ''>(kinds[0] ?? '');
  const toTypes = kind ? relationTargetTypes(asset.type, kind) : [];
  const [toType, setToType] = useState<LedgerAssetType | ''>(toTypes[0] ?? '');
  const [toId, setToId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [toPick, setToPick] = useState<SearchOption | null>(null);
  const searchAssets = async (q: string) =>
    (
      await ledgerApi.list({ type: toType as LedgerAssetType, q: q || undefined, pageSize: 50 })
    ).items
      .filter((a) => a.id !== asset.id)
      .map((a) => ({ id: a.id, label: a.name }));
  const mutation = useMutation({
    mutationFn: () =>
      ledgerApi.createRelation({ fromId: asset.id, toId, kind: kind as LedgerRelationKind }),
    onSuccess: () => {
      setToId('');
      setToPick(null);
      setError(null);
      onAdded();
    },
    onError: (e: Error) => setError(e.message),
  });
  if (kinds.length === 0) return null;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <Select
        aria-label="关系"
        className="w-28"
        value={kind}
        onChange={(e) => {
          const next = e.target.value as LedgerRelationKind;
          setKind(next);
          setToType(relationTargetTypes(asset.type, next)[0] ?? '');
          setToId('');
          setToPick(null);
        }}
      >
        {kinds.map((k) => (
          <option key={k} value={k}>
            {LEDGER_RELATION_LABELS[k]}
          </option>
        ))}
      </Select>
      <Select
        aria-label="对象类型"
        className="w-32"
        value={toType}
        onChange={(e) => {
          setToType(e.target.value as LedgerAssetType);
          setToId('');
          setToPick(null);
        }}
      >
        {toTypes.map((t) => (
          <option key={t} value={t}>
            {LEDGER_ASSET_TYPE_LABELS[t]}
          </option>
        ))}
      </Select>
      <SearchSelect
        id="ledger-relation-to"
        label="资产"
        ariaLabel="对象"
        inline
        value={toId}
        selected={toPick}
        queryKey={[LEDGER_QUERY_KEY, 'relation-options', toType]}
        search={searchAssets}
        enabled={Boolean(toType)}
        emptyLabel="选择资产"
        onChange={(id, option) => {
          setToId(id);
          setToPick(option);
        }}
      />
      <Button
        className="h-10"
        disabled={!toId || mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        添加
      </Button>
      {error && <span className="text-sm text-severity-critical">{error}</span>}
    </div>
  );
}

function RelationRows({
  rows,
  direction,
  canManage,
  onRemove,
}: {
  rows: LedgerRelationView[];
  direction: 'out' | 'in';
  canManage: boolean;
  onRemove: (id: string) => void;
}) {
  return (
    <>
      {rows.map((r) => (
        <TR key={r.id}>
          <TD data-label="关系">
            {direction === 'out'
              ? LEDGER_RELATION_LABELS[r.kind]
              : `被${LEDGER_RELATION_LABELS[r.kind]}`}
          </TD>
          <TD data-label="对象">
            <Link to={`/ledger/${r.asset.id}`} className="text-brand-700 hover:underline">
              {r.asset.name}
            </Link>
          </TD>
          <TD data-label="类型">{LEDGER_ASSET_TYPE_LABELS[r.asset.type]}</TD>
          {canManage && (
            <TD className="text-right">
              {direction === 'out' && (
                <Button size="sm" variant="ghost" onClick={() => onRemove(r.id)}>
                  删除
                </Button>
              )}
            </TD>
          )}
        </TR>
      ))}
    </>
  );
}

/** 台账资产详情：基本信息、专有字段、关联对象、关系、硬件。 */
export function LedgerAssetDetailPage() {
  const { id = '' } = useParams();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('ledger:manage');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { error: toastError } = useToast();
  const [editing, setEditing] = useState(false);
  const [quick, setQuick] = useState(false);
  const canQuick = hasPermission('detect_task:manage');
  const detail = useQuery({
    queryKey: [LEDGER_QUERY_KEY, 'detail', id],
    queryFn: () => ledgerApi.get(id),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: [LEDGER_QUERY_KEY] });
  const removeRelation = useMutation({
    mutationFn: (relationId: string) => ledgerApi.removeRelation(relationId),
    onSuccess: () => void refresh(),
    onError: (e: Error) => toastError(e.message),
  });
  const removeAsset = useMutation({
    mutationFn: () => ledgerApi.remove(id),
    onSuccess: () => {
      void refresh();
      navigate('/ledger');
    },
    onError: (e: Error) => toastError(e.message),
  });

  if (detail.isLoading) return <LoadingBlock />;
  if (detail.isError || !detail.data) {
    return (
      <p className="p-4 text-sm text-severity-critical">
        {(detail.error as Error | null)?.message ?? '资产不存在'}
      </p>
    );
  }
  const a = detail.data;
  const fields = LEDGER_ATTR_FIELDS[a.type];
  const relations = [...a.outgoing, ...a.incoming];

  return (
    <div className="space-y-4">
      <PageHeader
        title={a.name}
        actions={
          a.type === 'platform' || canManage || canQuick ? (
            <>
              {a.type === 'platform' && (
                <Link
                  to={`/analysis/profiles/${encodeURIComponent(a.id)}`}
                  className={buttonVariants({ variant: 'outline' })}
                >
                  安全画像
                </Link>
              )}
              {canQuick && <Button onClick={() => setQuick(true)}>快速建任务</Button>}
              {canManage && (
                <>
                  <Button variant="outline" onClick={() => setEditing(true)}>
                    编辑
                  </Button>
                  <Button
                    variant="outline"
                    disabled={removeAsset.isPending}
                    onClick={() => {
                      if (window.confirm(`删除资产「${a.name}」？关系会一并删除。`)) {
                        removeAsset.mutate();
                      }
                    }}
                  >
                    删除
                  </Button>
                </>
              )}
            </>
          ) : undefined
        }
      />

      <SectionCard title="基本信息">
        <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Item label="类型">{LEDGER_ASSET_TYPE_LABELS[a.type]}</Item>
          <Item label="名称">{a.name}</Item>
          <Item label="编号">{a.code}</Item>
          <Item label="组织">{a.organizationPath}</Item>
          <Item label="责任人">{a.ownerName}</Item>
          <Item label="责任部门">{a.ownerDepartment}</Item>
          <Item label="标签">{a.tags.join('、')}</Item>
          <Item label="更新时间">{formatDateTime(a.updatedAt)}</Item>
          {a.endpoint && (
            <>
              <Item label="关联终端">
                <Link
                  to={`/fleet/endpoints/${a.endpoint.id}`}
                  className="text-brand-700 hover:underline"
                >
                  {a.endpoint.hostname}
                </Link>
                {a.endpoint.removed && <span className="ml-2 text-xs text-ink-3">已移除</span>}
              </Item>
              <Item label="最近在线">{formatDateTime(a.endpoint.lastSeenAt)}</Item>
            </>
          )}
          {a.target && (
            <>
              <Item label="关联评估对象">{a.target.name}</Item>
              <Item label="模型">{a.target.model}</Item>
            </>
          )}
        </dl>
        {a.description && (
          <p className="mt-4 whitespace-pre-wrap text-sm text-ink-2">{a.description}</p>
        )}
      </SectionCard>

      {fields.length > 0 && (
        <SectionCard title={`${LEDGER_ASSET_TYPE_LABELS[a.type]}信息`}>
          <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {fields.map((f) => (
              <Item key={f.key} label={f.label}>
                {ledgerAttrText(a.type, f.key, a.attrs[f.key])}
              </Item>
            ))}
          </dl>
        </SectionCard>
      )}

      <SectionCard title="关系">
        {relations.length > 0 ? (
          <Table aria-label="关系列表">
            <THead>
              <TR>
                <TH>关系</TH>
                <TH>对象</TH>
                <TH>类型</TH>
                {canManage && <TH />}
              </TR>
            </THead>
            <TBody>
              <RelationRows
                rows={a.outgoing}
                direction="out"
                canManage={canManage}
                onRemove={(rid) => removeRelation.mutate(rid)}
              />
              <RelationRows
                rows={a.incoming}
                direction="in"
                canManage={canManage}
                onRemove={(rid) => removeRelation.mutate(rid)}
              />
            </TBody>
          </Table>
        ) : (
          <p className="text-sm text-ink-3">{DASH}</p>
        )}
        {canManage && <AddRelation asset={a} onAdded={() => void refresh()} />}
      </SectionCard>

      {LEDGER_ENDPOINT_LINK_TYPES.includes(a.type) && (
        <EndpointHardwareCards hardware={a.hardware} />
      )}

      {a.jobItems && (
        <SectionCard title="相关任务">
          {a.jobItems.length > 0 ? (
            <Table aria-label="相关任务">
              <THead>
                <TR>
                  <TH>子任务</TH>
                  <TH>组合任务</TH>
                  <TH>状态</TH>
                  <TH>时间</TH>
                </TR>
              </THead>
              <TBody>
                {a.jobItems.map((j) => (
                  <TR key={j.id}>
                    <TD data-label="子任务">
                      {j.href ? (
                        <Link to={j.href} className="text-brand-700 hover:underline">
                          {j.title}
                        </Link>
                      ) : (
                        j.title
                      )}
                    </TD>
                    <TD data-label="组合任务">
                      <Link
                        to={`/detect-tasks/jobs/${encodeURIComponent(j.jobId)}`}
                        className="text-brand-700 hover:underline"
                      >
                        {j.jobName}
                      </Link>
                    </TD>
                    <TD data-label="状态">
                      <DetectJobItemStatusBadge item={j} />
                    </TD>
                    <TD data-label="时间">{formatDateTime(j.createdAt)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : (
            <p className="text-sm text-ink-3">{DASH}</p>
          )}
        </SectionCard>
      )}

      {quick && <QuickJobModal assetId={a.id} onClose={() => setQuick(false)} />}

      {editing && (
        <LedgerAssetModal
          asset={a}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
