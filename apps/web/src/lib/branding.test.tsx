import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  composeDocumentTitle,
  resetBrandingForTest,
  safeLogo,
  setBranding,
  setPageName,
  useBranding,
} from './branding';
import { PRODUCT_NAME } from './product-name';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function Probe() {
  const b = useBranding();
  return (
    <div>
      <h1>{b.platformTitle}</h1>
      {b.platformLogo ? <img alt="平台logo" src={b.platformLogo} /> : null}
    </div>
  );
}

describe('平台品牌前端生效', () => {
  beforeEach(() => {
    resetBrandingForTest();
    document.querySelector('link[rel="icon"]')?.remove();
  });

  it('默认显示平台标题，页签标题为「鉴盾 · 大模型安全评估平台」', () => {
    render(<Probe />);
    expect(screen.getByRole('heading', { name: '鉴盾 · 大模型安全评估平台' })).toBeInTheDocument();
    expect(document.title).toBe('鉴盾 · 大模型安全评估平台');
  });

  it('保存后标题、平台logo、浏览器页签标题与 favicon 实时生效', () => {
    render(<Probe />);
    act(() =>
      setBranding({ platformTitle: '某租户安全评估平台', platformLogo: PNG, tabLogo: PNG }),
    );
    expect(screen.getByRole('heading', { name: '某租户安全评估平台' })).toBeInTheDocument();
    expect(screen.getByAltText('平台logo')).toHaveAttribute('src', PNG);
    expect(document.title).toBe('某租户安全评估平台');
    expect(document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href).toBe(PNG);
  });

  it('拒绝 SVG 与非图片 data URL', () => {
    expect(safeLogo('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
    expect(safeLogo('javascript:alert(1)')).toBeNull();
    expect(safeLogo(PNG)).toBe(PNG);
  });
});

describe('页签标题按页面区分', () => {
  beforeEach(() => {
    resetBrandingForTest();
  });

  it('有页面名时显示「页面名 · 鉴盾」，品牌名取自 PRODUCT_NAME', () => {
    setPageName('评估任务');
    expect(document.title).toBe(`评估任务 · ${PRODUCT_NAME}`);
  });

  it('清空页面名后回到默认平台标题', () => {
    setPageName('评估任务');
    setPageName(null);
    expect(document.title).toBe('鉴盾 · 大模型安全评估平台');
  });

  it('租户自定义了平台标题时用租户标题，不露出产品名', () => {
    setBranding({ platformTitle: '某租户安全评估平台' });
    setPageName('报告管理');
    expect(document.title).toBe('报告管理 · 某租户安全评估平台');
  });

  it('品牌信息晚于页面名到达时，页面名不丢', () => {
    setPageName('报告管理');
    act(() => setBranding({ platformTitle: '某租户安全评估平台' }));
    expect(document.title).toBe('报告管理 · 某租户安全评估平台');
  });

  it('composeDocumentTitle 在没有页面名时原样返回平台标题', () => {
    expect(composeDocumentTitle('任意标题', null)).toBe('任意标题');
  });
});
