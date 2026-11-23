import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, assetDiscoveryApi, type AssetDiscoveryScope } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/page-kit/SectionCard';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

export function splitList(text: string): string[] {
  return text
    .split(/[\s,，、]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parsePorts(text: string): number[] | null {
  const items = splitList(text);
  const ports = items.map(Number);
  if (ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) return null;
  return [...new Set(ports)];
}

/** 按 URL 处理的目标：完整 URL，或「主机:端口」（与后端一致，端口取自目标）。 */
export function isUrlTarget(text: string): boolean {
  const t = text.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^[^\s/:]+:\d{1,5}$/.test(t);
}

/** 与后端一致的主机数计算：CIDR 为 2^(32-前缀)，单个 IP/主机名/URL 为 1。 */
export function countHosts(targets: string[]): number {
  return targets.reduce((sum, t) => {
    if (isUrlTarget(t)) return sum + 1;
    const m = /\/(\d{1,2})$/.exec(t);
    return sum + (m ? 2 ** (32 - Number(m[1])) : 1);
  }, 0);
}

export function ScopeCard({
  scope,
  canEdit,
}: {
  scope: AssetDiscoveryScope | undefined;
  canEdit: boolean;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [entries, setEntries] = useState('');
  const [ports, setPorts] = useState('');
  const [maxHosts, setMaxHosts] = useState('64');

  useEffect(() => {
    if (!scope) return;
    setEntries(scope.entries.join('\n'));
    setPorts(scope.ports.join(', '));
    setMaxHosts(String(scope.maxHostsPerRun));
  }, [scope]);

  const save = useMutation({
    mutationFn: (body: AssetDiscoveryScope) => assetDiscoveryApi.saveScope(body),
    onSuccess: () => {
      toast.success('扫描范围已保存');
      void qc.invalidateQueries({ queryKey: ['asset-discovery', 'scope'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : '保存失败'),
  });

  const onSave = () => {
    const parsedPorts = parsePorts(ports);
    const max = Number(maxHosts);
    if (!parsedPorts) return toast.error('端口需为 1–65535 的整数');
    if (!Number.isInteger(max) || max < 1 || max > 256) {
      return toast.error('单次主机数上限需为 1–256');
    }
    save.mutate({ entries: splitList(entries), ports: parsedPorts, maxHostsPerRun: max });
  };

  const empty = !scope || scope.entries.length === 0 || scope.ports.length === 0;

  return (
    <SectionCard
      title="扫描范围"
      description={
        <>
          {empty
            ? '未配置扫描范围，默认不扫描任何地址'
            : `已授权 ${scope.entries.length} 个范围条目、${scope.ports.length} 个端口，单次最多 ${scope.maxHostsPerRun} 台主机`}
        </>
      }
      bodyClassName="space-y-4"
    >
      <Field
        label="授权范围（CIDR 或主机）"
        htmlFor="asset-discovery-entries"
        hint="每行一个，例如 10.0.0.0/24 或 gpu-01.lan；CIDR 前缀不小于 /16，链路本地与组播地址不可配置。"
      >
        <Textarea
          id="asset-discovery-entries"
          rows={4}
          value={entries}
          disabled={!canEdit}
          onChange={(e) => setEntries(e.target.value)}
        />
      </Field>
      <Field
        label="授权端口"
        htmlFor="asset-discovery-ports"
        hint="逗号分隔，最多 16 个，例如 11434, 8000, 9997"
      >
        <Input
          id="asset-discovery-ports"
          value={ports}
          disabled={!canEdit}
          onChange={(e) => setPorts(e.target.value)}
        />
      </Field>
      <Field label="单次主机数上限" htmlFor="asset-discovery-max" hint="1–256，/24 为 256 台">
        <Input
          id="asset-discovery-max"
          type="number"
          min={1}
          max={256}
          value={maxHosts}
          disabled={!canEdit}
          onChange={(e) => setMaxHosts(e.target.value)}
        />
      </Field>
      {canEdit ? (
        <Button type="button" onClick={onSave} disabled={save.isPending}>
          {save.isPending ? '保存中…' : '保存范围'}
        </Button>
      ) : (
        <p className="text-sm text-ink-3">仅平台管理员可修改扫描范围。</p>
      )}
    </SectionCard>
  );
}
