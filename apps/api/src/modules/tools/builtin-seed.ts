import type { PrismaClient } from '@prisma/client';
import { BUILTIN_PROBE_TOOL_CODE } from '@lse/shared';

// 内置工具的种子：只建缺失的工具；已存在时只校正「内置、启用」两个标记，
// 管理员改过的名称、说明、参数、隐藏状态都保留。不引用 db.ts，seed 脚本直接传自己的客户端。

const PROBE_INSTRUCTIONS = [
  '1. 在「终端与智能体」的「接入」页签创建接入码。',
  '2. Linux 终端：复制页面上的一键安装命令，以 root 身份执行。',
  '3. Windows 终端：按架构下载安装包，以管理员身份运行。',
  '4. 安装完成后回到「终端与智能体」查看终端是否上线。',
].join('\n');

export const BUILTIN_TOOLS = [
  {
    code: BUILTIN_PROBE_TOOL_CODE,
    name: '终端探针',
    category: 'app_env',
    description: '装在受测终端上，盘点智能体、技能和 MCP，并执行终端测评。',
    instructions: PROBE_INSTRUCTIONS,
    configParams: [
      {
        name: 'server',
        label: '平台地址',
        description: '探针回连的平台地址，一键命令和安装包里已自动写入',
        defaultValue: '',
        required: true,
      },
      {
        name: 'enrollment-code',
        label: '接入码',
        description: '在「终端与智能体」的「接入」页签创建，默认 24 小时有效',
        defaultValue: '',
        required: true,
      },
    ],
    taskEntry: 'fleet-onboard',
  },
] as const;

export async function ensureBuiltinTools(db: Pick<PrismaClient, 'tool'>): Promise<void> {
  for (const tool of BUILTIN_TOOLS) {
    await db.tool.upsert({
      where: { code: tool.code },
      create: {
        ...tool,
        configParams: tool.configParams.map((p) => ({ ...p })),
        builtin: true,
        enabled: true,
      },
      update: { builtin: true, enabled: true },
    });
  }
}
