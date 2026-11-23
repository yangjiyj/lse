import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  createServiceAssuranceSbomChannel,
  SERVICE_ASSURANCE_SBOM_TTL_SECONDS,
  SbomChannelError,
  serviceAssuranceSbomKey,
  type SbomChannelStore,
} from '../src/modules/service-assurance/sbom-channel.js';
import { parseSbomUpload } from '../src/modules/service-assurance/sbom.js';

const fixture = () =>
  readFile(
    new URL('./fixtures/service-assurance/cyclonedx-triton-affected.json', import.meta.url),
    'utf8',
  );

class MemoryStore implements SbomChannelStore {
  readonly values = new Map<string, string>();
  readonly ttl = new Map<string, number>();

  async set(
    key: string,
    value: string,
    mode: 'EX',
    ttlSeconds: number,
    condition: 'NX',
  ): Promise<'OK' | null> {
    assert.equal(mode, 'EX');
    assert.equal(condition, 'NX');
    if (this.values.has(key)) return null;
    this.values.set(key, value);
    this.ttl.set(key, ttlSeconds);
    return 'OK';
  }

  async getdel(key: string): Promise<string | null> {
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    this.ttl.delete(key);
    return value;
  }

  async del(key: string): Promise<number> {
    const existed = this.values.delete(key);
    this.ttl.delete(key);
    return existed ? 1 : 0;
  }
}

test('SBOM 内容只进入短 TTL 通道并由 Worker 原子消费一次', async () => {
  const content = await fixture();
  const contentType = 'application/vnd.cyclonedx+json';
  const parsed = parseSbomUpload({ contentType, content });
  const store = new MemoryStore();
  const channel = createServiceAssuranceSbomChannel(store);
  const runId = '10000000-0000-4000-8000-000000000010';

  await channel.put(runId, { contentType, content, parsed });

  const key = serviceAssuranceSbomKey(runId);
  assert.equal(store.ttl.get(key), SERVICE_ASSURANCE_SBOM_TTL_SECONDS);
  assert.match(store.values.get(key) ?? '', /"schemaVersion":1/);
  assert.doesNotMatch(key, /content|sha256|path|command/i);

  const consumed = await channel.take(runId);
  assert.equal(consumed.parsed.contentSha256, parsed.contentSha256);
  assert.equal(consumed.content, content);
  assert.equal(store.values.has(key), false);
  await assert.rejects(
    channel.take(runId),
    (error: unknown) =>
      error instanceof SbomChannelError &&
      error.code === 'SERVICE_ASSURANCE_SBOM_CONTENT_UNAVAILABLE',
  );
});

test('通道拒绝覆盖同一运行并在摘要或内容被篡改时失败关闭', async () => {
  const content = await fixture();
  const contentType = 'application/vnd.cyclonedx+json';
  const parsed = parseSbomUpload({ contentType, content });
  const store = new MemoryStore();
  const channel = createServiceAssuranceSbomChannel(store);
  const runId = '10000000-0000-4000-8000-000000000011';

  await channel.put(runId, { contentType, content, parsed });
  await assert.rejects(
    channel.put(runId, { contentType, content, parsed }),
    (error: unknown) =>
      error instanceof SbomChannelError && error.code === 'SERVICE_ASSURANCE_SBOM_CHANNEL_CONFLICT',
  );

  const key = serviceAssuranceSbomKey(runId);
  const envelope = JSON.parse(store.values.get(key) ?? '{}') as Record<string, unknown>;
  envelope.contentSha256 = '0'.repeat(64);
  store.values.set(key, JSON.stringify(envelope));
  await assert.rejects(
    channel.take(runId),
    (error: unknown) =>
      error instanceof SbomChannelError && error.code === 'SERVICE_ASSURANCE_SBOM_CONTENT_INVALID',
  );
  assert.equal(store.values.has(key), false);
});
