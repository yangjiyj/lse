import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const relayUrl = new URL('../src/modules/engines/relay-audit.ts', import.meta.url);

test('relay-audit 使用独立公共范围与文本工具', async () => {
  const source = await readFile(relayUrl, 'utf8');

  assert.match(source, /from '\.\.\/\.\.\/lib\/scanner-scope\.js'/);
  assert.match(source, /from '\.\/normalize-utils\.js'/);
  assert.doesNotMatch(source, /ai[-_]infra[-_]guard/i);
  assert.doesNotMatch(source, /allowedHosts/);
});
