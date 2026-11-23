import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomId } from './random-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('randomId', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('浏览器提供 randomUUID 时直接使用', () => {
    vi.stubGlobal('crypto', { randomUUID: () => '11111111-2222-4333-8444-555555555555', getRandomValues: crypto.getRandomValues.bind(crypto) });
    expect(randomId()).toBe('11111111-2222-4333-8444-555555555555');
  });

  it('http 访问（非安全上下文）没有 randomUUID 时仍生成合法随机标识，不让页面白屏', () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) });
    const a = randomId();
    const b = randomId();
    expect(a).toMatch(UUID);
    expect(b).toMatch(UUID);
    expect(a).not.toBe(b);
  });
});

describe('页面代码不直接调用 crypto.randomUUID', () => {
  it('现网用 http 访问，直接调用会让新建评估等页面白屏', () => {
    const root = join(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !path.endsWith(join('lib', 'random-id.ts'))) {
          if (/crypto\.randomUUID\s*\(/.test(readFileSync(path, 'utf8'))) offenders.push(path.slice(root.length + 1));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
