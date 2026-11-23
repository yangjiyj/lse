import { useState, type ReactNode } from 'react';
import type {
  AssetDiscoveryHit,
  AssetDiscoveryModelDetail,
  AssetDiscoveryRun,
  DiscoveredServiceType,
} from '@/lib/api';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { formatDateTime } from '@/lib/format';
import type { RegisterDraft } from './RegisterTargetModal';

export const SERVICE_TYPE_LABEL: Record<DiscoveredServiceType, string> = {
  OLLAMA: 'Ollama',
  VLLM: 'vLLM',
  XINFERENCE: 'Xinference',
  LM_STUDIO: 'LM Studio',
  OPENAI_COMPATIBLE: 'OpenAI 兼容',
  TGI: 'TGI',
  TRITON: 'Triton',
};

export const RUN_STATUS_LABEL: Record<AssetDiscoveryRun['status'], string> = {
  PENDING: '排队中',
  RUNNING: '扫描中',
  COMPLETED: '已完成',
  FAILED: '失败',
};

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-sm text-slate-500">{children}</div>;
}

export function RunsTable({
  runs,
  selectedId,
  onSelect,
}: {
  runs: AssetDiscoveryRun[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (!runs.length) return <Empty>暂无数据</Empty>;
  return (
    <Table>
      <THead>
        <TR>
          <TH>发起时间</TH>
          <TH>发起人</TH>
          <TH>范围</TH>
          <TH>端点数</TH>
          <TH>状态</TH>
          <TH>识别服务</TH>
          <TH>操作</TH>
        </TR>
      </THead>
      <TBody>
        {runs.map((r) => (
          <TR key={r.id} className={r.id === selectedId ? 'bg-slate-100' : undefined}>
            <TD data-label="发起时间" className="whitespace-nowrap tabular-nums">
              {formatDateTime(r.createdAt)}
            </TD>
            <TD data-label="发起人">{r.createdByName ?? '—'}</TD>
            <TD data-label="范围" className="max-w-[16rem] truncate" title={r.targets.join(', ')}>
              {r.targets.join(', ')}
            </TD>
            <TD data-label="端点数" className="tabular-nums">
              {r.endpointCount}
            </TD>
            <TD data-label="状态">
              <span
                className={r.status === 'FAILED' ? 'text-severity-critical' : undefined}
                title={r.error ?? ''}
              >
                {RUN_STATUS_LABEL[r.status]}
              </span>
            </TD>
            <TD data-label="识别服务" className="tabular-nums">
              {r.status === 'COMPLETED' ? r.hitCount : '—'}
            </TD>
            <TD data-label="操作">
              <button
                type="button"
                className="text-brand-600 hover:underline"
                onClick={() => onSelect(r.id)}
              >
                查看结果
              </button>
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

export function HitsTable({
  hits,
  canRegister,
  onRegister,
}: {
  hits: AssetDiscoveryHit[];
  canRegister: boolean;
  onRegister: (d: RegisterDraft) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  if (!hits.some((h) => h.matches.length)) return <Empty>暂无数据</Empty>;
  const rows = hits.flatMap((h) => {
    // 只有模型名（如 Triton）时展开也没有内容，不给展开按钮
    const details = (h.modelDetails ?? []).some(hasConfig) ? h.modelDetails! : [];
    const open = expanded.has(h.id);
    const list = h.matches.map((m, i) => ({
      h,
      m,
      key: `${h.id}-${i}`,
      toggle: i === 0 && details.length > 0 ? { open } : null,
      details: null as AssetDiscoveryModelDetail[] | null,
    }));
    if (open && details.length) {
      list.push({ h, m: h.matches[0]!, key: `${h.id}-details`, toggle: null, details });
    }
    return list;
  });
  return (
    <Table>
      <THead>
        <TR>
          <TH>地址</TH>
          <TH>服务类型</TH>
          <TH>模型</TH>
          <TH>是否已登记</TH>
          <TH>探测依据</TH>
          <TH>操作</TH>
        </TR>
      </THead>
      <TBody>
        {rows.map(({ h, m, key, toggle: t, details }) =>
          details ? (
            <TR key={key} className="hover:bg-transparent">
              <TD colSpan={6} className="bg-slate-50 py-3">
                <ModelDetailsTable details={details} />
              </TD>
            </TR>
          ) : (
            <TR key={key}>
              <TD data-label="地址" className="font-mono text-xs">
                <span>{h.baseUrl}</span>
                {t ? (
                  <button
                    type="button"
                    aria-expanded={t.open}
                    className="ml-2 font-sans text-brand-600 hover:underline"
                    onClick={() => toggle(h.id)}
                  >
                    模型配置
                  </button>
                ) : null}
              </TD>
              <TD data-label="服务类型">{SERVICE_TYPE_LABEL[h.serviceType] ?? h.serviceType}</TD>
              <TD data-label="模型">{m.model ?? '未返回模型名'}</TD>
              <TD data-label="是否已登记">
                {m.registered ? (
                  <span>已登记（{m.targetName}）</span>
                ) : (
                  <span className="text-severity-high">未登记 AI 服务</span>
                )}
              </TD>
              <TD data-label="探测依据" className="text-xs text-slate-500">
                {h.evidence}
              </TD>
              <TD data-label="操作">
                {!m.registered && canRegister && h.serviceType !== 'TRITON' && m.model ? (
                  <button
                    type="button"
                    className="text-brand-600 hover:underline"
                    onClick={() =>
                      onRegister({
                        baseUrl: h.baseUrl,
                        model: m.model!,
                        serviceLabel: SERVICE_TYPE_LABEL[h.serviceType] ?? h.serviceType,
                      })
                    }
                  >
                    登记为评估对象
                  </button>
                ) : (
                  <span className="text-slate-500">—</span>
                )}
              </TD>
            </TR>
          ),
        )}
      </TBody>
    </Table>
  );
}

function hasConfig(d: AssetDiscoveryModelDetail): boolean {
  return [d.family, d.parameterSize, d.quantization, d.dtype, d.contextLength].some(
    (v) => v !== undefined && v !== '',
  );
}

function ModelDetailsTable({ details }: { details: AssetDiscoveryModelDetail[] }) {
  const dash = (v: string | number | undefined) => (v === undefined || v === '' ? '—' : v);
  // 精度目前只有 TGI 返回，其他服务不占一列
  const showDtype = details.some((d) => d.dtype);
  return (
    <Table fit>
      <THead>
        <TR>
          <TH>模型</TH>
          <TH>系列</TH>
          <TH>参数量</TH>
          <TH>量化</TH>
          {showDtype ? <TH>精度</TH> : null}
          <TH>上下文长度</TH>
        </TR>
      </THead>
      <TBody>
        {details.map((d, i) => (
          <TR key={`${d.name}-${i}`}>
            <TD data-label="模型" className="break-all">
              {d.name}
            </TD>
            <TD data-label="系列">{dash(d.family)}</TD>
            <TD data-label="参数量">{dash(d.parameterSize)}</TD>
            <TD data-label="量化">{dash(d.quantization)}</TD>
            {showDtype ? <TD data-label="精度">{dash(d.dtype)}</TD> : null}
            <TD data-label="上下文长度" className="tabular-nums">
              {dash(d.contextLength)}
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
