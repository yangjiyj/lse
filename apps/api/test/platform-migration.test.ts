import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prisma } from '../src/db.js';

test('PLATFORM_APP 枚举迁移可重复应用', async () => {
  const sql = readFileSync(new URL('../prisma/migrations/20261020120000_platform_app_target/migration.sql',import.meta.url),'utf8');
  try {
    await prisma.$executeRawUnsafe(sql);
    await prisma.$executeRawUnsafe(sql);
    const rows = await prisma.$queryRaw<Array<{label:string}>>`SELECT enumlabel AS label FROM pg_enum WHERE enumtypid = '"TargetType"'::regtype AND enumlabel = 'PLATFORM_APP'`;
    assert.equal(rows.length,1);
  } finally { await prisma.$disconnect(); }
});
