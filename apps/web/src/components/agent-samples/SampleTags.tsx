import { Badge } from '@/components/ui/badge';
import type { BadgeTone } from '@/lib/format';
import type { AgentSample } from '@/lib/api';

export const ENVIRONMENT = { sandbox: '蜜罐沙箱', real_config: '真实配置' } as const;

/** 危害的色调：能直接造成外泄、凭据暴露、执行的偏红，改动与破坏类偏橙，被诱导类偏蓝。 */
const HARM_TONE: Record<string, BadgeTone> = {
  credential_read: 'danger', exfiltrate: 'danger', exec_remote: 'danger', escalate: 'danger',
  persist: 'warning', delete: 'warning', overwrite: 'warning', sabotage: 'warning',
  exfiltration: 'danger', credential_access: 'danger', untrusted_command: 'danger',
  destructive_delete: 'warning', out_of_scope_write: 'warning', indirect_instruction: 'info',
};

type TagSource = Pick<AgentSample, 'vectorLabel' | 'harm' | 'harmLabel' | 'environment' | 'source' | 'enabled' | 'version'>;

/** 样本的一组标签：攻击类别、危害、运行环境、出处（内置 / 自定义 + 版本）。类别和危害同名时只显示一个。 */
export function SampleTags({ item }: { item: TagSource }) {
  return (
    <div className="flex flex-wrap gap-1">
      <Badge tone="info" className="whitespace-nowrap">{item.vectorLabel}</Badge>
      {item.harmLabel !== item.vectorLabel && (
        <Badge tone={HARM_TONE[item.harm] ?? 'warning'} className="whitespace-nowrap">{item.harmLabel}</Badge>
      )}
      <Badge tone={item.environment === 'sandbox' ? 'success' : 'neutral'} className="whitespace-nowrap">
        {ENVIRONMENT[item.environment]}
      </Badge>
      <Badge tone="neutral" className="whitespace-nowrap">
        {`${item.source === 'builtin' ? '内置' : '自定义'}${item.version ? ` · v${item.version}` : ''}${item.enabled === false ? ' · 已停用' : ''}`}
      </Badge>
    </div>
  );
}
