import { createHash } from 'node:crypto';
import type { EndpointRiskRow } from '../../../../../packages/shared/src/endpoint-overview.js';
import { fleetAgentIdentity } from '../../../../../packages/shared/src/fleet-agent-display.js';
import { AGENT_KINDS, arr, rec, str } from './inventory.js';
const descriptions: Record<
  string,
  { title: string; level: 'HIGH' | 'MEDIUM'; advice: string; basis: string }
> = {
  'blast.docker_socket': {
    title: '智能体可以直接操作 Docker',
    level: 'HIGH',
    basis: '当前用户对 Docker 控制接口有写权限。',
    advice: '取消当前用户对 docker.sock 的写权限，或让智能体改用受限账号运行',
  },
  'blast.ssh_key_unencrypted': {
    title: '把 SSH 私钥没有设口令',
    level: 'HIGH',
    basis: '探针发现未设置口令的 SSH 私钥。',
    advice: '给私钥设置口令，或把不用的私钥移出 ~/.ssh',
  },
  'config.bypass_prompt_accepted': {
    title: '关闭了危险操作确认',
    level: 'HIGH',
    basis: '智能体已接受跳过危险操作确认提示。',
    advice: '在智能体设置里恢复危险操作确认，并取消已接受的跳过提示',
  },
  'cred.plaintext_key': {
    title: '配置文件里有明文凭据',
    level: 'MEDIUM',
    basis: '探针在配置文件中发现明文凭据。',
    advice: '改用环境变量或密钥管理，并轮换已暴露的凭据',
  },
  'data.transcript_secret': {
    title: '会话记录里留有密钥',
    level: 'MEDIUM',
    basis: '探针在会话记录中发现密钥。',
    advice: '清理含密钥的会话记录，并轮换这些密钥',
  },
};
/** 只使用受控文案；原始标签、路径、指纹及凭据内容均不进入展示结果。 */
export function aggregateBlast(report: unknown): EndpointRiskRow[] {
  const groups = new Map<
    string,
    { subjects: Map<string, number>; agents: Set<number>; names: Set<string>; host: boolean }
  >();
  arr(rec(report).assets).forEach((a, index) => {
    if (!AGENT_KINDS.has(str(a.kind))) return;
    for (const p of arr(rec(a.evidence).posture)) {
      const key = str(p.key);
      if (p.status !== 'finding' || !descriptions[key]) continue;
      const group = groups.get(key) ?? {
        subjects: new Map(),
        agents: new Set(),
        names: new Set(),
        host: false,
      };
      const fingerprint = str(p.subject_hash) || `installation-${index}`;
      group.subjects.set(
        fingerprint,
        Math.max(
          group.subjects.get(fingerprint) ?? 0,
          typeof p.count === 'number' && p.count > 0 ? p.count : 1,
        ),
      );
      group.agents.add(index);
      group.names.add(fleetAgentIdentity(str(a.name)));
      group.host ||= p.scope === 'host';
      groups.set(key, group);
    }
  });
  return [...groups]
    .map(([key, group]): EndpointRiskRow => {
      const description = descriptions[key]!;
      const count = group.host ? 1 : [...group.subjects.values()].reduce((n, v) => n + v, 0);
      const names = [...group.names].sort();
      return {
        id: `${key}:${createHash('sha256')
          .update([...group.subjects.keys()].sort().join('|'))
          .digest('hex')
          .slice(0, 16)}`,
        level: description.level,
        category: key.startsWith('data.')
          ? 'data'
          : key.startsWith('cred.')
            ? 'credential'
            : 'blast',
        title:
          key === 'blast.ssh_key_unencrypted' ? `${count} ${description.title}` : description.title,
        involved: group.host ? `${group.agents.size} 个智能体所在账号` : names.join('、'),
        basis: description.basis,
        advice: description.advice,
        subjectCount: count,
        subjects: names.slice(0, 50).map((name) => ({ name, detail: description.basis })),
        moreCount: Math.max(0, names.length - 50),
      };
    })
    .sort(
      (a, b) =>
        (a.level === 'HIGH' ? 0 : 1) - (b.level === 'HIGH' ? 0 : 1) || a.id.localeCompare(b.id),
    );
}
