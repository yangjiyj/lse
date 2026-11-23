// 部署时在 api 容器里登记预置工具的文件（src 下的脚本会进镜像，apps/api/scripts 不会）。
// 用法（容器内 /app 下）：
//   pnpm exec tsx apps/api/src/modules/tools/register-preset-cli.ts \
//     --code corpus-scan-cli --file /tmp/corpus-scan-cli-1.0.9.tar.gz --version 1.0.9 [--notes 版本说明]
// 输出一行 JSON：toolId、versionId、是否新建、sha256。
import { prisma } from '../../db.js';
import { isPresetToolCode, registerPresetToolVersion } from './preset.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const code = arg('--code') ?? '';
  const file = arg('--file') ?? '';
  const version = arg('--version') ?? '';
  if (!isPresetToolCode(code) || !file || !version) {
    console.error(
      '用法：register-preset-cli.ts --code corpus-scan-cli --file <文件> --version <版本> [--notes 说明]',
    );
    process.exit(2);
  }
  const result = await registerPresetToolVersion(prisma, {
    code,
    file,
    version,
    releaseNotes: arg('--notes'),
  });
  console.log(JSON.stringify(result));
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
