import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_PLATFORM_TITLE_TEXT,
  PRODUCT_NAME,
  PRODUCT_NAME_EN,
  PRODUCT_FULL_NAME,
} from './product-name';

describe('product-name', () => {
  it('常量值', () => {
    expect(PRODUCT_NAME).toBe('鉴盾');
    expect(PRODUCT_FULL_NAME).toBe('大模型安全评估平台');
    expect(PRODUCT_NAME_EN).toBe('AI Safety Assessment');
    expect(DEFAULT_PLATFORM_TITLE_TEXT).toBe('鉴盾 · 大模型安全评估平台');
  });

  it('index.html 的 <title> 与 DEFAULT_PLATFORM_TITLE_TEXT 一致（该文件无法引用常量，防止改一处漏一处）', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');
    const m = /<title>([^<]*)<\/title>/.exec(html);
    expect(m?.[1]?.trim()).toBe(DEFAULT_PLATFORM_TITLE_TEXT);
  });
});
