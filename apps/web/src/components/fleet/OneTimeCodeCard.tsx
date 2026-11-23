import { useState } from 'react';
import { Download, KeyRound } from 'lucide-react';
import {
  api,
  type FleetDeploymentInfo,
  type FleetEnrollmentCodeCreated,
  type FleetInstallerTarget,
} from '@/lib/api';
import { buildOneclickCommand, errorMessage } from '@/lib/fleet';
import { formatDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { NoteBox } from '@/components/page-kit/NoteBox';
import { CodeBlock } from './CodeBlock';

type Platform = 'linux' | 'windows';
const PLATFORMS: Array<{ id: Platform; label: string }> = [
  { id: 'linux', label: 'Linux' },
  { id: 'windows', label: 'Windows' },
];

const INSTALLERS: Array<{ target: FleetInstallerTarget; arch: string }> = [
  { target: 'windows-amd64', arch: 'x64' },
  { target: 'windows-arm64', arch: 'ARM64' },
];

type Oneclick = FleetDeploymentInfo['oneclick'] | undefined;

function LinuxPanel({ code, oneclick }: { code: string; oneclick: Oneclick }) {
  if (!oneclick?.available || !oneclick.scriptUrl || !oneclick.scriptSha256) {
    return (
      <NoteBox tone="warning" role="alert">
        <p className="font-semibold">Linux 一键安装暂不可用</p>
        {oneclick?.reasons?.length ? (
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {oneclick.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : null}
        <p className="mt-1">请联系平台管理员完成部署配置。</p>
      </NoteBox>
    );
  }
  return (
    <div className="space-y-3">
      <CodeBlock
        label="Linux 一键命令（需 sudo，粘贴到终端执行）"
        text={buildOneclickCommand({
          scriptUrl: oneclick.scriptUrl,
          scriptSha256: oneclick.scriptSha256,
          scriptFile: oneclick.scriptFile,
          code,
        })}
        copyLabel="复制一键命令"
      />
      <p className="text-[12.5px] text-ink-3">
        命令会先校验脚本的 SHA-256
        再执行；接入码执行时会出现在本机进程列表中，请仅在可信终端上运行。
      </p>
    </div>
  );
}

function WindowsPanel({ code, oneclick }: { code: string; oneclick: Oneclick }) {
  const [busy, setBusy] = useState<FleetInstallerTarget | null>(null);
  const [error, setError] = useState<string | null>(null);

  const states = INSTALLERS.map(({ target, arch }) => {
    const installer = oneclick?.targets.find((t) => t.target === target)?.installer;
    const reason = installer?.available
      ? undefined
      : (installer?.reason ??
        (oneclick
          ? '服务端未提供该架构的 Windows 安装包，请联系平台管理员完成部署配置'
          : '部署信息尚未加载完成，请稍后刷新页面重试'));
    return { target, arch, available: installer?.available === true, reason };
  });
  // 两个架构原因相同时只写一次，否则分别写明。
  const unavailable = states.filter((s) => !s.available);
  const distinct = [...new Set(unavailable.map((s) => s.reason!))];
  const reasonLines =
    distinct.length === 1 && unavailable.length === states.length
      ? distinct
      : unavailable.map((s) => `${s.arch}：${s.reason}`);

  const download = async (target: FleetInstallerTarget) => {
    setError(null);
    setBusy(target);
    try {
      await api.fleet.downloadWindowsInstaller(code, target);
    } catch (err) {
      setError(errorMessage(err, '下载失败，请稍后重试'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {states.map((s) => (
          <Button
            key={s.target}
            size="sm"
            variant={s.target === 'windows-amd64' ? 'primary' : 'outline'}
            disabled={!s.available || busy !== null}
            title={s.reason}
            onClick={() => void download(s.target)}
          >
            <Download className="h-3.5 w-3.5" />
            {busy === s.target ? '下载中…' : `下载安装包（${s.arch}）`}
          </Button>
        ))}
      </div>
      {reasonLines.length > 0 && (
        <NoteBox tone="warning">
          <p className="font-semibold">Windows 安装包暂不可用</p>
          {reasonLines.map((r) => (
            <p key={r}>{r}</p>
          ))}
        </NoteBox>
      )}
      {error && (
        <NoteBox tone="warning" role="alert">
          {error}
        </NoteBox>
      )}
      <ul className="list-disc space-y-0.5 pl-5 text-[12.5px] leading-5 text-ink-3">
        <li>下载后双击运行，按提示允许管理员权限即可完成接入。</li>
        <li>
          批量下发可用 <code className="font-mono">安装包.exe /quiet</code> 静默安装。
        </li>
        <li>
          安装包暂未做代码签名，首次运行如出现「Windows 已保护你的电脑」，点「更多信息 →
          仍要运行」。
        </li>
      </ul>
    </div>
  );
}

function OneclickPanel({ code, oneclick, initialPlatform }: { code: string; oneclick: Oneclick; initialPlatform: Platform }) {
  const [platform, setPlatform] = useState<Platform>(initialPlatform);
  return (
    <div className="space-y-3 rounded-xl border border-line bg-white/70 p-4">
      <div>
        <h4 className="text-[14px] font-bold text-ink">一键接入终端</h4>
        <p className="mt-0.5 text-[13px] text-ink-3">
          选择终端的系统：Linux 粘贴一条命令，Windows 下载安装包双击运行。
        </p>
      </div>
      <div role="group" aria-label="终端系统" className="flex flex-wrap gap-2">
        {PLATFORMS.map((p) => (
          <Button
            key={p.id}
            size="sm"
            variant={platform === p.id ? 'primary' : 'outline'}
            aria-pressed={platform === p.id}
            onClick={() => setPlatform(p.id)}
          >
            {p.label}
          </Button>
        ))}
      </div>
      {platform === 'linux' ? (
        <LinuxPanel code={code} oneclick={oneclick} />
      ) : (
        <WindowsPanel code={code} oneclick={oneclick} />
      )}
    </div>
  );
}

/** 一次性展示卡：关闭后组件卸载，明文不再保留。 */
export function OneTimeCodeCard({
  created,
  oneclick,
  onClose,
  initialPlatform = 'linux',
}: {
  created: FleetEnrollmentCodeCreated;
  oneclick?: FleetDeploymentInfo['oneclick'];
  onClose: () => void;
  initialPlatform?: Platform;
}) {
  return (
    <section
      role="status"
      aria-label="新接入码"
      className="rounded-card border-2 border-[#F0C75E] bg-[#FFFBEB] p-5 shadow-card"
    >
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#FFE9A8] text-[#7A4B00]">
          <KeyRound className="h-4.5 w-4.5" />
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <h3 className="text-[15px] font-bold text-ink">接入码「{created.item.label}」已创建</h3>
            <p className="mt-0.5 text-[13px] font-semibold text-[#7A4B00]">
              请现在复制并妥善保存：关闭后无法再次查看。
            </p>
          </div>
          <CodeBlock label="接入码（仅此一次显示）" text={created.code} copyLabel="复制接入码" />
          <OneclickPanel code={created.code} oneclick={oneclick} initialPlatform={initialPlatform} />
          <p className="text-[13px] text-ink-3">
            可接入 {created.item.maxUses} 台终端，有效至 {formatDateTime(created.item.expiresAt)}
            。接入码是敏感凭据，不要发到聊天里；下载的 Windows 安装包里已内置接入码，也请妥善保管。
          </p>
          <Button variant="outline" size="sm" onClick={onClose}>
            我已保存，关闭
          </Button>
        </div>
      </div>
    </section>
  );
}
