import type { AiComponentAssetType, AiComponentConfig } from '@/lib/api';

export type Source = 'endpoint' | 'upload';
export type UploadKind = 'archive' | 'files';

interface Option<T extends string> {
  value: T;
  label: string;
  summary?: string;
}

const SOURCE_OPTIONS: Record<Source, Option<Source>> = {
  endpoint: {
    value: 'endpoint',
    label: '连接运行中的服务（在线拉取工具清单）',
    summary:
      '检测工具名称、描述与参数定义中的工具投毒、隐藏指令，并与历史基线对比发现工具定义变更（rug pull）；不调用工具。',
  },
  upload: {
    value: 'upload',
    label: '上传源码（压缩包 / 目录 / 文件）',
    summary:
      '静态分析代码与说明文档：命令执行、数据外发、硬编码密钥、权限过大、依赖已知漏洞等；不执行代码。',
  },
};

/** 仅 MCP Server 支持在线拉取；Skill / 插件只能上传源码。 */
export function sourcesFor(assetType: AiComponentAssetType): Source[] {
  return assetType === 'MCP' ? ['endpoint', 'upload'] : ['upload'];
}

export function defaultSource(assetType: AiComponentAssetType): Source {
  return sourcesFor(assetType)[0]!;
}

const UPLOAD_OPTIONS: Option<UploadKind>[] = [
  { value: 'archive', label: '压缩包（zip / tar / tgz）' },
  { value: 'files', label: '目录或多个文件' },
];

function RadioGroup<T extends string>(props: {
  label: string;
  name: string;
  options: Option<T>[];
  value: T;
  onChange: (v: T) => void;
  compact?: boolean;
}) {
  const { label, name, options, value, onChange, compact } = props;
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={compact ? 'flex flex-wrap gap-2' : 'grid gap-2'}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <label
            key={o.value}
            className={`flex cursor-pointer flex-col gap-1 rounded-lg border px-3 py-2 text-sm ${active ? 'border-brand-600 bg-brand-50' : 'border-line hover:border-line-2'}`}
          >
            <span className="flex items-center gap-2 font-medium text-ink">
              <input
                type="radio"
                name={name}
                value={o.value}
                checked={active}
                onChange={() => onChange(o.value)}
              />
              {o.label}
            </span>
            {o.summary ? <span className="text-xs leading-5 text-ink-3">{o.summary}</span> : null}
          </label>
        );
      })}
    </div>
  );
}

export function SourcePicker(props: {
  assetType: AiComponentAssetType;
  value: Source;
  onChange: (v: Source) => void;
}) {
  const options = sourcesFor(props.assetType).map((s) => SOURCE_OPTIONS[s]);
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-ink">检测方式</span>
      <RadioGroup
        label="检测方式"
        name="aic-source"
        options={options}
        value={props.value}
        onChange={props.onChange}
      />
    </div>
  );
}

export function UploadKindPicker(props: { value: UploadKind; onChange: (v: UploadKind) => void }) {
  return (
    <RadioGroup
      label="上传形式"
      name="aic-upload-kind"
      options={UPLOAD_OPTIONS}
      value={props.value}
      onChange={props.onChange}
      compact
    />
  );
}

const READ_ONLY_NOTE =
  '仅发起 initialize、tools/list 及 prompts/list、resources/list 等只读请求，不调用工具。';
const ALWAYS_BLOCKED = '回环与链路本地地址（127.0.0.0/8、169.254.0.0/16、::1、fe80::/10 等）';

/** MCP 服务地址提示：与 mcp-fetch/egress.ts 及 target-egress-policy.ts 的实际行为一致。 */
export function endpointHint(egress: AiComponentConfig['mcpFetch']['egress']): string {
  const head = '支持 Streamable HTTP 与 SSE。';
  if (!egress)
    return `${head}平台始终拒绝${ALWAYS_BLOCKED}；若管理员配置了出站允许清单，仅可访问清单内地址。${READ_ONLY_NOTE}`;
  if (!egress.allowlistConfigured) {
    return `${head}当前未配置出站允许清单：可访问公网与内网地址（10.0.0.0/8、172.16.0.0/12、192.168.0.0/16）；平台始终拒绝${ALWAYS_BLOCKED}。${READ_ONLY_NOTE}`;
  }
  if (egress.allowPrivateNetworks) {
    return `${head}管理员已配置出站允许清单并开启内网访问：仅可访问清单内地址（含清单内的内网地址）；${ALWAYS_BLOCKED}须登记在清单内方可访问。${READ_ONLY_NOTE}`;
  }
  return `${head}管理员已配置出站允许清单，未开启内网访问：仅可访问清单内的公网地址，内网、回环与链路本地地址均不可访问。${READ_ONLY_NOTE}`;
}

/** 在线拉取因地址被出站策略拒绝（MCP_URL_NOT_ALLOWED）时的处理建议。 */
export const URL_NOT_ALLOWED_ADVICE =
  '处理建议：目标为本机服务（localhost、127.0.0.1）时，请改用宿主机的内网地址（如 192.168.x.x）；地址不在出站允许清单内时，请联系管理员在出站策略中登记该地址，内网地址还需开启内网访问。';
