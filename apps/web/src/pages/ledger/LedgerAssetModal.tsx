import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  LEDGER_ASSET_TYPES,
  LEDGER_ASSET_TYPE_LABELS,
  LEDGER_ATTR_FIELDS,
  LEDGER_ENDPOINT_LINK_TYPES,
  LEDGER_TARGET_LINK_TYPES,
  type LedgerAssetType,
  type LedgerAttrField,
} from '@lse/shared';
import { useAuth } from '@/lib/auth';
import { flattenOrgTree, organizationApi } from '@/lib/organizations';
import {
  LEDGER_QUERY_KEY,
  ledgerApi,
  type LedgerAsset,
  type LedgerAssetInput,
  type LedgerAttrs,
} from '@/lib/ledger';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { SearchSelect, type SearchOption } from './SearchSelect';

type Draft = Record<string, string>;

function draftOf(attrs: LedgerAttrs | undefined): Draft {
  return Object.fromEntries(Object.entries(attrs ?? {}).map(([k, v]) => [k, String(v)]));
}

/** 只取该类型的专有字段，空值不提交，数字字段转成数字。 */
export function attrsForType(type: LedgerAssetType, draft: Draft): LedgerAttrs {
  const out: LedgerAttrs = {};
  for (const field of LEDGER_ATTR_FIELDS[type]) {
    const raw = (draft[field.key] ?? '').trim();
    if (!raw) continue;
    out[field.key] = field.input === 'number' ? Number(raw) : raw;
  }
  return out;
}

function AttrInput({
  field,
  value,
  onChange,
}: {
  field: LedgerAttrField;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = `ledger-attr-${field.key}`;
  return (
    <Field label={field.label} htmlFor={id}>
      {field.input === 'select' ? (
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">未选择</option>
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          id={id}
          type={field.input === 'number' ? 'number' : 'text'}
          inputMode={field.input === 'number' ? 'decimal' : undefined}
          min={field.input === 'number' ? 0 : undefined}
          maxLength={field.max ?? (field.input === 'url' ? 2000 : 200)}
          placeholder={
            field.input === 'url' ? 'https://' : field.input === 'host' ? 'IP 或主机名' : undefined
          }
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

/** 新建、编辑台账资产。专有字段按 LEDGER_ATTR_FIELDS 生成，类型建好后不能改。 */
export function LedgerAssetModal({
  asset,
  defaultType = 'platform',
  onClose,
  onSaved,
}: {
  asset?: LedgerAsset;
  defaultType?: LedgerAssetType;
  onClose: () => void;
  onSaved: (asset: LedgerAsset) => void;
}) {
  const { hasPermission } = useAuth();
  const editing = Boolean(asset);
  const [type, setType] = useState<LedgerAssetType>(asset?.type ?? defaultType);
  const [name, setName] = useState(asset?.name ?? '');
  const [code, setCode] = useState(asset?.code ?? '');
  const [organizationId, setOrganizationId] = useState(asset?.organizationId ?? '');
  const [ownerName, setOwnerName] = useState(asset?.ownerName ?? '');
  const [ownerDepartment, setOwnerDepartment] = useState(asset?.ownerDepartment ?? '');
  const [tags, setTags] = useState((asset?.tags ?? []).join('，'));
  const [description, setDescription] = useState(asset?.description ?? '');
  const [draft, setDraft] = useState<Draft>(draftOf(asset?.attrs));
  const [fleetEndpointId, setFleetEndpointId] = useState(asset?.fleetEndpointId ?? '');
  const [modelTargetId, setModelTargetId] = useState(asset?.modelTargetId ?? '');
  const [endpointPick, setEndpointPick] = useState<SearchOption | null>(
    asset?.endpoint ? { id: asset.endpoint.id, label: asset.endpoint.hostname } : null,
  );
  const [targetPick, setTargetPick] = useState<SearchOption | null>(
    asset?.target ? { id: asset.target.id, label: asset.target.name } : null,
  );
  const [error, setError] = useState<string | null>(null);

  const canLinkEndpoint = LEDGER_ENDPOINT_LINK_TYPES.includes(type);
  const targetTypes = LEDGER_TARGET_LINK_TYPES[type];

  const orgs = useQuery({
    queryKey: [LEDGER_QUERY_KEY, 'org-options'],
    queryFn: () => organizationApi.tree(),
    enabled: hasPermission('org:read'),
  });
  const orgOptions = flattenOrgTree(orgs.data?.items ?? []);
  const canListLinks = hasPermission('model_target:read');
  const searchEndpoints = async (q: string) =>
    (await ledgerApi.endpointOptions(q)).items.map((e) => ({ id: e.id, label: e.hostname }));
  const searchTargets = async (q: string) =>
    (await ledgerApi.targetOptions(q)).items
      .filter((t) => targetTypes?.includes(t.targetType))
      .map((t) => ({ id: t.id, label: t.name }));

  const mutation = useMutation({
    mutationFn: () => {
      const body: LedgerAssetInput = {
        type,
        name: name.trim(),
        code: code.trim() || null,
        description: description.trim(),
        ownerName: ownerName.trim() || null,
        ownerDepartment: ownerDepartment.trim() || null,
        organizationId: organizationId || null,
        tags: tags
          .split(/[,，\s]+/)
          .map((t) => t.trim())
          .filter(Boolean),
        attrs: attrsForType(type, draft),
        fleetEndpointId: canLinkEndpoint ? fleetEndpointId || null : null,
        modelTargetId: targetTypes ? modelTargetId || null : null,
      };
      if (asset) {
        const { type: _type, ...patch } = body;
        return ledgerApi.update(asset.id, patch);
      }
      return ledgerApi.create(body);
    },
    onSuccess: onSaved,
    onError: (e: Error) => setError(e.message),
  });

  const setAttr = (key: string, value: string) => setDraft((d) => ({ ...d, [key]: value }));

  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      title={editing ? '编辑资产' : '新建资产'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!name.trim() || mutation.isPending} onClick={() => mutation.mutate()}>
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="类型" htmlFor="ledger-type" required>
            <Select
              id="ledger-type"
              value={type}
              disabled={editing}
              onChange={(e) => setType(e.target.value as LedgerAssetType)}
            >
              {LEDGER_ASSET_TYPES.map((t) => (
                <option key={t} value={t}>
                  {LEDGER_ASSET_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="名称" htmlFor="ledger-name" required>
            <Input
              id="ledger-name"
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="编号" htmlFor="ledger-code">
            <Input
              id="ledger-code"
              value={code}
              maxLength={64}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
          <Field label="组织" htmlFor="ledger-org">
            <Select
              id="ledger-org"
              value={organizationId}
              onChange={(e) => setOrganizationId(e.target.value)}
            >
              <option value="">未选择</option>
              {orgOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.path}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="责任人" htmlFor="ledger-owner">
            <Input
              id="ledger-owner"
              value={ownerName}
              maxLength={50}
              onChange={(e) => setOwnerName(e.target.value)}
            />
          </Field>
          <Field label="责任部门" htmlFor="ledger-dept">
            <Input
              id="ledger-dept"
              value={ownerDepartment}
              maxLength={100}
              onChange={(e) => setOwnerDepartment(e.target.value)}
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {LEDGER_ATTR_FIELDS[type].map((field) => (
            <AttrInput
              key={`${type}-${field.key}`}
              field={field}
              value={draft[field.key] ?? ''}
              onChange={(v) => setAttr(field.key, v)}
            />
          ))}
          {canLinkEndpoint && (
            <Field label="关联终端" htmlFor="ledger-endpoint">
              <SearchSelect
                id="ledger-endpoint"
                label="终端"
                value={fleetEndpointId}
                selected={endpointPick}
                queryKey={[LEDGER_QUERY_KEY, 'endpoint-options']}
                search={searchEndpoints}
                enabled={canListLinks}
                emptyLabel="不关联"
                onChange={(id, option) => {
                  setFleetEndpointId(id);
                  setEndpointPick(option);
                }}
              />
            </Field>
          )}
          {targetTypes && (
            <Field label="关联评估对象" htmlFor="ledger-target">
              <SearchSelect
                id="ledger-target"
                label="评估对象"
                value={modelTargetId}
                selected={targetPick}
                queryKey={[LEDGER_QUERY_KEY, 'target-options', type]}
                search={searchTargets}
                enabled={canListLinks}
                emptyLabel="不关联"
                onChange={(id, option) => {
                  setModelTargetId(id);
                  setTargetPick(option);
                }}
              />
            </Field>
          )}
        </div>

        <Field label="标签" htmlFor="ledger-tags">
          <Input id="ledger-tags" value={tags} onChange={(e) => setTags(e.target.value)} />
        </Field>
        <Field label="描述" htmlFor="ledger-desc">
          <Textarea
            id="ledger-desc"
            rows={3}
            maxLength={2000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        {error && <p className="text-sm text-severity-critical">{error}</p>}
      </div>
    </Modal>
  );
}
