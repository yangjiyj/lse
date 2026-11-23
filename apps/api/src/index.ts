import { buildApp } from './app.js';
import { config } from './config.js';
import { prisma } from './db.js';
import { ensureInstallSeed } from './lib/license-enforcement.js';

async function main(): Promise<void> {
  const app = await buildApp();
  try {
    await prisma.$connect();
    await ensureInstallSeed();
    await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`received ${signal}, shutting down...`);
    try {
      await app.close();
      await prisma.$disconnect();
      process.exit(0);
    } catch (err) {
      app.log.error(err);
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
