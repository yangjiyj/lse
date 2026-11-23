import { chmod, writeFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../../apps/api/src/lib/password.js';

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const prisma = new PrismaClient();

try {
  const stateFile = required('SERVICE_ASSURANCE_E2E_STATE_FILE');
  const runKey = required('SERVICE_ASSURANCE_E2E_RUN_KEY');
  const auditorUsername = required('SERVICE_ASSURANCE_E2E_AUDITOR_USERNAME');
  const auditorPassword = required('SERVICE_ASSURANCE_E2E_AUDITOR_PASSWORD');
  const sentinel = required('SERVICE_ASSURANCE_E2E_SENTINEL');
  const affectedUrl = required('SERVICE_ASSURANCE_E2E_AFFECTED_URL');
  const admin = await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } });
  const auditorRole = await prisma.role.findUniqueOrThrow({ where: { name: 'auditor' } });
  const auditor = await prisma.user.create({
    data: {
      username: auditorUsername,
      passwordHash: await hashPassword(auditorPassword),
      displayName: '受控验收审计员',
      isActive: true,
      roles: { create: { roleId: auditorRole.id } },
    },
  });
  const target = await prisma.modelTarget.create({
    data: {
      name: `服务安全核验受控对象-${runKey}`,
      provider: 'local-controlled',
      baseUrl: affectedUrl,
      apiKey: sentinel,
      model: 'controlled-service',
      createdById: admin.id,
    },
  });
  const task = await prisma.evalTask.create({
    data: {
      name: 'AI 服务安全核验受控验收任务',
      description: '用于三模式、误报、权限与报告端到端验收。',
      status: 'COMPLETED',
      modelTargetId: target.id,
      engines: [],
      dimensions: ['service_assurance'],
      concurrency: 1,
      progress: 1,
      startedAt: new Date(),
      finishedAt: new Date(),
      createdById: admin.id,
    },
  });
  await writeFile(
    stateFile,
    JSON.stringify({
      taskId: task.id,
      targetId: target.id,
      auditorUsername: auditor.username,
      auditorUserId: auditor.id,
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
  await chmod(stateFile, 0o600);
  console.log('[ok] isolated service assurance task prepared');
} finally {
  await prisma.$disconnect();
}
