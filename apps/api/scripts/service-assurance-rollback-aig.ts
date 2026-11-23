import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  previewAigRollback,
  requireAbsoluteReceiptPath,
  rollbackAigMigration,
} from './service-assurance-migrate-aig.js';

interface RollbackCliOptions {
  mode: 'PREVIEW' | 'APPLY';
  receiptPath: string;
  rollbackReceiptPath: string | null;
}

function parseRollbackCliOptions(argv: string[]): RollbackCliOptions {
  let mode: RollbackCliOptions['mode'] = 'PREVIEW';
  let receiptPath: string | null = null;
  let rollbackReceiptPath: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--preview') mode = 'PREVIEW';
    else if (arg === '--apply') mode = 'APPLY';
    else if (arg === '--receipt') receiptPath = requireAbsoluteReceiptPath(argv[++index]);
    else if (arg === '--rollback-receipt') {
      rollbackReceiptPath = requireAbsoluteReceiptPath(argv[++index]);
    } else throw new Error(`不支持的参数：${arg}`);
  }
  if (!receiptPath) {
    throw new Error('必须提供 --receipt <绝对路径>');
  }
  if (mode === 'APPLY' && !rollbackReceiptPath) {
    throw new Error('--apply 必须同时提供 --rollback-receipt <绝对路径>');
  }
  return { mode, receiptPath, rollbackReceiptPath };
}

async function main(): Promise<void> {
  const options = parseRollbackCliOptions(process.argv.slice(2));
  await import('../src/env.js');
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  try {
    if (options.mode === 'PREVIEW') {
      const preview = await previewAigRollback(db, { receiptPath: options.receiptPath });
      console.log(JSON.stringify({ mode: 'PREVIEW', ...preview }, null, 2));
      return;
    }
    const result = await rollbackAigMigration(db, {
      receiptPath: options.receiptPath,
      rollbackReceiptPath: options.rollbackReceiptPath!,
    });
    console.log(JSON.stringify({ mode: 'APPLY', ...result }, null, 2));
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : '回滚执行失败');
    process.exitCode = 1;
  });
}
