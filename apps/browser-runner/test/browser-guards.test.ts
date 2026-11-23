import assert from 'node:assert/strict';
import test from 'node:test';
import { guardWebSocket, type GuardableWebSocket } from '../src/browser.js';
import { createTelemetry } from '../src/evidence.js';
import type { DnsResolver } from '../src/ip-guard.js';
import { testConfig } from './helpers.js';

class StaticResolver implements DnsResolver {
  constructor(private readonly addresses: string[]) {}

  async lookup(): Promise<string[]> {
    return this.addresses;
  }
}

test('websocket guard closes forbidden network targets and records evidence', async () => {
  const telemetry = createTelemetry();
  const config = testConfig();
  const closeCalls: Array<{ code?: number; reason?: string }> = [];
  const ws: GuardableWebSocket = {
    url: () => 'ws://169.254.169.254/socket',
    close: async (options) => {
      closeCalls.push(options ?? {});
    },
  };

  await guardWebSocket(ws, telemetry, config, new StaticResolver(['169.254.169.254']));

  assert.equal(closeCalls.length, 1);
  assert.equal(closeCalls[0]?.code, 1008);
  assert.ok(
    telemetry.networkBlocks.some((line) =>
      line.includes('blocked websocket ws://169.254.169.254/socket'),
    ),
    JSON.stringify(telemetry.networkBlocks),
  );
  assert.ok(
    telemetry.networkBlocks.some((line) => line.includes('forbidden_ip:169.254.0.0/16')),
    JSON.stringify(telemetry.networkBlocks),
  );
});
