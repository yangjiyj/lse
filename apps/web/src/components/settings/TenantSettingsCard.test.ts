import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ ApiError: class extends Error {}, api: {} }));

import { logoFileError } from './TenantSettingsCard';

function file(name: string, type: string, size = 10) {
  return new File([new Uint8Array(size)], name, { type });
}

describe('租户logo上传校验', () => {
  it('允许 png/jpg/ico/webp', () => {
    expect(logoFileError(file('a.png', 'image/png'))).toBeNull();
    expect(logoFileError(file('a.jpg', 'image/jpeg'))).toBeNull();
    expect(logoFileError(file('a.ico', 'image/x-icon'))).toBeNull();
    expect(logoFileError(file('a.webp', 'image/webp'))).toBeNull();
  });
  it('禁止 SVG、其他格式与超大文件', () => {
    expect(logoFileError(file('a.svg', 'image/svg+xml'))).toBe('不支持 SVG 格式');
    expect(logoFileError(file('a.png', 'image/svg+xml'))).toBe('不支持 SVG 格式');
    expect(logoFileError(file('a.gif', 'image/gif'))).toMatch(/仅支持/);
    expect(logoFileError(file('a.png', 'image/png', 300 * 1024))).toMatch(/不能超过 256 KB/);
  });
});
