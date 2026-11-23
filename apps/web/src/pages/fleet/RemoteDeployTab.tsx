import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NoteBox } from '@/components/page-kit/NoteBox';
import { RadioPills } from '@/components/page-kit/RadioPills';
import { SectionCard } from '@/components/page-kit/SectionCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { LoadingBlock, Spinner } from '@/components/ui/spinner';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { copyText, errorMessage } from '@/lib/fleet';
import type { BadgeTone } from '@/lib/format';
import {
  isDeployActive,
  REMOTE_DEPLOY_STATUS_LABELS,
  REMOTE_DEPLOY_TARGET_MS,
  remoteDeployApi,
  type RemoteDeploy,
  type RemoteDeployHostKey,
  type SshDeployInput,
} from '@/lib/remote-deploy';

const STATUS_TONE: Record<RemoteDeploy['status'], BadgeTone> = {
  PENDING: 'neutral',
  CONNECTING: 'info',
  INSTALLING: 'info',
  SUCCEEDED: 'success',
  FAILED: 'danger',
  EXPIRED: 'neutral',
};

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;

/** 远程部署（2.4.8）：SSH 推送安装探针，或生成一次性部署命令；记录各阶段耗时。 */
export function RemoteDeployTab() {
  const capability = useQuery({
    queryKey: ['fleet', 'remote-deploy', 'capability'],
    queryFn: () => remoteDeployApi.capability(),
  });
  if (capability.isLoading) return <LoadingBlock />;
  const cap = capability.data;
  return (
    <div className="space-y-5">
      {cap && !cap.ssh && (
        <NoteBox tone="warning" role="status">
          平台未安装 SSH 客户端，只能使用一次性部署命令
        </NoteBox>
      )}
      {cap && !cap.oneclick && (
        <NoteBox tone="warning" role="status">
          一键安装包还没配置好，暂时不能部署，请联系平台管理员
        </NoteBox>
      )}
      {cap?.ssh && <SshDeployForm disabled={!cap.oneclick} />}
      <ManualDeploySection disabled={!cap?.oneclick} />
      <DeployRecords />
    </div>
  );
}

function SshDeployForm({ disabled }: { disabled: boolean }) {
  const id = useId();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('root');
  const [authType, setAuthType] = useState<'password' | 'key'>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [sudoPassword, setSudoPassword] = useState('');
  const [enableEval, setEnableEval] = useState(false);
  const [runPosture, setRunPosture] = useState(true);
  const [hostKey, setHostKey] = useState<RemoteDeployHostKey | null>(null);
  const [verified, setVerified] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const portNumber = Number(port);
  const portOk = Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535;
  // 主机或端口改了，之前取到的指纹作废
  const changeTarget = (next: { host?: string; port?: string }) => {
    if (next.host !== undefined) setHost(next.host);
    if (next.port !== undefined) setPort(next.port);
    setHostKey(null);
    setVerified(false);
  };
  const scan = useMutation({
    mutationFn: () => remoteDeployApi.hostKey({ host: host.trim(), port: portNumber }),
    onSuccess: (key) => {
      setHostKey(key);
      setVerified(false);
    },
    onError: (err) => toast.error(errorMessage(err, '取不到主机指纹')),
  });

  const credentialOk = authType === 'password' ? password.length > 0 : privateKey.trim().length > 0;
  const canDeploy =
    !disabled &&
    !submitting &&
    host.trim().length > 0 &&
    portOk &&
    username.trim().length > 0 &&
    credentialOk &&
    hostKey !== null &&
    verified;
  const needSudo = username.trim() !== 'root';

  const clearSecrets = () => {
    setPassword('');
    setPrivateKey('');
    setPassphrase('');
    setSudoPassword('');
  };
  // 不用 useMutation：请求体带口令、私钥，不能留在查询缓存里。
  const deploy = async () => {
    if (!canDeploy || !hostKey) return;
    const body: SshDeployInput = {
      host: host.trim(),
      port: portNumber,
      username: username.trim(),
      auth:
        authType === 'password'
          ? { type: 'password', password }
          : { type: 'key', privateKey, ...(passphrase ? { passphrase } : {}) },
      ...(needSudo && sudoPassword ? { sudoPassword } : {}),
      hostKeyFingerprint: hostKey.fingerprint,
      hostKeyType: hostKey.type,
      enableEval,
      runPosture,
    };
    clearSecrets();
    setSubmitting(true);
    try {
      await remoteDeployApi.startSsh(body);
      toast.success('已开始部署');
      setHostKey(null);
      setVerified(false);
      void queryClient.invalidateQueries({ queryKey: ['fleet', 'remote-deploy', 'list'] });
    } catch (err) {
      toast.error(errorMessage(err, '部署失败'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section aria-label="SSH 部署">
      <SectionCard title="SSH 部署">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="主机" htmlFor={`${id}-host`} required className="lg:col-span-2">
            <Input
              id={`${id}-host`}
              value={host}
              autoComplete="off"
              onChange={(e) => changeTarget({ host: e.target.value })}
            />
          </Field>
          <Field label="端口" htmlFor={`${id}-port`}>
            <Input
              id={`${id}-port`}
              inputMode="numeric"
              value={port}
              onChange={(e) => changeTarget({ port: e.target.value })}
            />
          </Field>
          <Field label="用户名" htmlFor={`${id}-user`} required>
            <Input
              id={`${id}-user`}
              value={username}
              autoComplete="off"
              onChange={(e) => setUsername(e.target.value)}
            />
          </Field>
          <Field label="认证方式" className="sm:col-span-2 lg:col-span-4">
            <RadioPills
              name={`${id}-auth`}
              options={[
                { value: 'password', label: '口令' },
                { value: 'key', label: '私钥' },
              ]}
              value={authType}
              onChange={setAuthType}
            />
          </Field>
          {authType === 'password' ? (
            <Field label="口令" htmlFor={`${id}-password`} required className="lg:col-span-2">
              <Input
                id={`${id}-password`}
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
          ) : (
            <>
              <Field
                label="私钥"
                htmlFor={`${id}-key`}
                required
                className="sm:col-span-2 lg:col-span-3"
              >
                <Textarea
                  id={`${id}-key`}
                  rows={4}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono text-xs"
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                />
              </Field>
              <Field label="私钥口令" htmlFor={`${id}-passphrase`}>
                <Input
                  id={`${id}-passphrase`}
                  type="password"
                  autoComplete="new-password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                />
              </Field>
            </>
          )}
          {needSudo && (
            <Field label="sudo 口令" htmlFor={`${id}-sudo`} className="lg:col-span-2">
              <Input
                id={`${id}-sudo`}
                type="password"
                autoComplete="new-password"
                value={sudoPassword}
                onChange={(e) => setSudoPassword(e.target.value)}
              />
            </Field>
          )}
          <div className="flex flex-wrap items-center gap-5 sm:col-span-2 lg:col-span-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={enableEval}
                onChange={(e) => setEnableEval(e.target.checked)}
              />
              开启真机测评
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={runPosture}
                onChange={(e) => setRunPosture(e.target.checked)}
              />
              部署后自动体检
            </label>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <Button
            variant="outline"
            disabled={!host.trim() || !portOk || scan.isPending}
            onClick={() => scan.mutate()}
          >
            {scan.isPending && <Spinner className="h-4 w-4" />}
            获取主机指纹
          </Button>
          {hostKey && (
            <>
              <span className="text-[13px] text-ink-2">
                {hostKey.type}
                <span className="ml-2 break-all font-mono">{hostKey.fingerprint}</span>
              </span>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={verified}
                  onChange={(e) => setVerified(e.target.checked)}
                />
                已核对指纹
              </label>
            </>
          )}
          <Button className="ml-auto" disabled={!canDeploy} onClick={() => void deploy()}>
            {submitting && <Spinner className="h-4 w-4" />}
            部署
          </Button>
        </div>
      </SectionCard>
    </section>
  );
}

function ManualDeploySection({ disabled }: { disabled: boolean }) {
  const id = useId();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [host, setHost] = useState('');
  const [enableEval, setEnableEval] = useState(false);
  const [runPosture, setRunPosture] = useState(true);
  const [command, setCommand] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // 命令带一次性接入码，只放在组件状态里，不进查询缓存。
  const create = async () => {
    setCreating(true);
    try {
      const res = await remoteDeployApi.createManual({
        host: host.trim(),
        enableEval,
        runPosture,
      });
      setCommand(res.command);
      void queryClient.invalidateQueries({ queryKey: ['fleet', 'remote-deploy', 'list'] });
    } catch (err) {
      toast.error(errorMessage(err, '生成部署命令失败'));
    } finally {
      setCreating(false);
    }
  };
  const copy = async () => {
    if (command && (await copyText(command))) toast.success('已复制');
    else toast.error('复制失败，请手动选中复制');
  };

  return (
    <section aria-label="一次性部署命令">
      <SectionCard title="一次性部署命令">
        <div className="flex flex-wrap items-end gap-4">
          <Field label="主机" htmlFor={`${id}-host`} required className="min-w-[16rem] flex-1">
            <Input
              id={`${id}-host`}
              value={host}
              autoComplete="off"
              onChange={(e) => setHost(e.target.value)}
            />
          </Field>
          <label className="flex h-9 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enableEval}
              onChange={(e) => setEnableEval(e.target.checked)}
            />
            开启真机测评
          </label>
          <label className="flex h-9 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={runPosture}
              onChange={(e) => setRunPosture(e.target.checked)}
            />
            部署后自动体检
          </label>
          <Button
            variant="outline"
            disabled={disabled || creating || !host.trim()}
            onClick={() => void create()}
          >
            生成部署命令
          </Button>
        </div>
        {command && (
          <div className="mt-4 space-y-2">
            <div className="flex items-start gap-2">
              <pre
                aria-label="部署命令"
                className="flex-1 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-slate-900 p-3 font-mono text-xs text-slate-100"
              >
                {command}
              </pre>
              <Button variant="outline" size="sm" onClick={() => void copy()}>
                复制
              </Button>
            </div>
            <p className="text-[12.5px] text-severity-medium">命令只显示这一次。</p>
          </div>
        )}
      </SectionCard>
    </section>
  );
}

function Duration({ ms }: { ms: number | null }) {
  if (ms === null) return <span className="text-ink-3">—</span>;
  const within = ms <= REMOTE_DEPLOY_TARGET_MS;
  return (
    <span className={within ? 'text-emerald-600' : 'text-orange-600'}>
      {seconds(ms)}
      {!within && '（超过 30 秒）'}
    </span>
  );
}

/** 各阶段相对开始的时间。 */
function Phases({ d }: { d: RemoteDeploy }) {
  const start = d.startedAt ?? d.scriptFetchedAt ?? d.createdAt;
  const base = Date.parse(start);
  const phases: Array<[string, string | null]> = [
    ['连接', d.connectedAt],
    ['上传', d.uploadedAt],
    ['取脚本', d.scriptFetchedAt],
    ['安装', d.installedAt],
    ['登记', d.registeredAt],
    ['首次上报', d.firstReportAt],
  ];
  const shown = phases.filter(([, at]) => at);
  if (shown.length === 0) return <span className="text-ink-3">—</span>;
  return (
    <span className="text-[12.5px] text-ink-2">
      {shown
        .map(([label, at]) => `${label} +${seconds(Math.max(0, Date.parse(at!) - base))}`)
        .join(' · ')}
    </span>
  );
}

function DeployRecords() {
  const records = useQuery({
    queryKey: ['fleet', 'remote-deploy', 'list'],
    queryFn: () => remoteDeployApi.list({ page: 1, pageSize: 50 }),
    refetchInterval: (q) => (q.state.data?.items.some(isDeployActive) ? 3000 : false),
  });
  const rows = records.data?.items ?? [];
  return (
    <SectionCard title="部署记录">
      {records.isLoading ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <EmptyState title="还没有部署记录" />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>主机</TH>
              <TH>方式</TH>
              <TH>状态</TH>
              <TH>部署耗时</TH>
              <TH>各阶段</TH>
              <TH>终端</TH>
              <TH>体检任务</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((d) => (
              <TR key={d.id}>
                <TD className="font-mono text-[13px]">
                  {d.mode === 'ssh' && d.port ? `${d.host}:${d.port}` : d.host}
                </TD>
                <TD>{d.mode === 'ssh' ? 'SSH' : '一次性命令'}</TD>
                <TD>
                  <Badge tone={STATUS_TONE[d.status] ?? 'neutral'}>
                    {REMOTE_DEPLOY_STATUS_LABELS[d.status] ?? d.status}
                  </Badge>
                  {d.errorMessage && (
                    <div
                      className={`mt-1 max-w-[18rem] text-[12.5px] ${
                        d.status === 'FAILED' ? 'text-destructive' : 'text-severity-medium'
                      }`}
                    >
                      {d.errorMessage}
                    </div>
                  )}
                </TD>
                <TD className="whitespace-nowrap tabular-nums">
                  <Duration ms={d.durationMs} />
                </TD>
                <TD>
                  <Phases d={d} />
                </TD>
                <TD>
                  {d.endpointHref ? (
                    <Link to={d.endpointHref} className="text-brand-600 hover:underline">
                      查看终端
                    </Link>
                  ) : (
                    '—'
                  )}
                </TD>
                <TD>
                  {d.postureTaskHref ? (
                    <Link to={d.postureTaskHref} className="text-brand-600 hover:underline">
                      查看体检
                    </Link>
                  ) : (
                    '—'
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </SectionCard>
  );
}
