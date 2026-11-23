import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  maskBankCard,
  maskEmail,
  maskIdCard,
  maskName,
  maskPhone,
  maskSensitiveText,
} from '@/lib/sensitive';

const apiMock = vi.hoisted(() => ({ get: vi.fn(), reveal: vi.fn() }));
vi.mock('@/lib/api', () => ({
  api: { dataSecurity: { get: apiMock.get, reveal: apiMock.reveal } },
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { username: 'auditor01' } }) }));

import { SensitiveText, SensitiveValue } from './SensitiveText';
import { PageWatermark } from './PageWatermark';
import { resetDataSecurityForTest } from '@/lib/data-security';

describe('敏感信息脱敏规则', () => {
  it('手机号、身份证号、邮箱、银行卡号、姓名', () => {
    expect(maskPhone('13812345678')).toBe('138****5678');
    expect(maskIdCard('11010519491231002X')).toBe('110***********002X');
    expect(maskEmail('zhangsan@example.com')).toBe('zh******@example.com');
    expect(maskBankCard('6222021234567890123')).toBe('6222 *********** 0123');
    expect(maskName('张三')).toBe('张*');
    expect(maskName('欧阳娜娜')).toBe('欧**娜');
  });

  it('自由文本识别并脱敏，普通数字不误伤', () => {
    const r = maskSensitiveText(
      '联系 13812345678，身份证 11010519491231002X，卡号 6222 0212 3456 7890，邮箱 a.b@x.cn，订单 20260928',
    );
    expect(r.text).toContain('138****5678');
    expect(r.text).toContain('110***********002X');
    expect(r.text).toContain('6222 ******** 7890');
    expect(r.text).toContain('a.*@x.cn');
    expect(r.text).toContain('订单 20260928');
    expect(r.kinds).toEqual(['id_card', 'bank_card', 'phone', 'email']);
  });
});

describe('SensitiveValue / SensitiveText / PageWatermark', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDataSecurityForTest();
  });

  it('默认脱敏；无权限时不显示「查看明文」', async () => {
    apiMock.get.mockResolvedValue({
      maskSensitive: true,
      downloadWatermark: true,
      pageWatermark: true,
      canViewPlain: false,
    });
    render(<SensitiveValue kind="email" value="zhangsan@example.com" field="users.email" />);
    expect(screen.getByTestId('sensitive-value')).toHaveTextContent('zh******@example.com');
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /查看明文/ })).not.toBeInTheDocument();
  });

  it('有权限者点击「查看明文」先写审计再展示明文', async () => {
    apiMock.get.mockResolvedValue({
      maskSensitive: true,
      downloadWatermark: true,
      pageWatermark: true,
      canViewPlain: true,
    });
    apiMock.reveal.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(
      <SensitiveText
        text="请拨打 13812345678"
        field="answer.content"
        targetType="eval_result"
        targetId="r1"
      />,
    );
    expect(screen.getByText(/138\*\*\*\*5678/)).toBeInTheDocument();
    expect(screen.getByText(/已脱敏：手机号/)).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /查看明文/ }));
    expect(apiMock.reveal).toHaveBeenCalledWith({
      kind: 'phone',
      field: 'answer.content',
      targetType: 'eval_result',
      targetId: 'r1',
    });
    expect(await screen.findByText(/13812345678/)).toBeInTheDocument();
  });

  it('关闭脱敏后展示原文；页面水印包含用户名，可关闭', async () => {
    apiMock.get.mockResolvedValue({
      maskSensitive: false,
      downloadWatermark: true,
      pageWatermark: false,
      canViewPlain: false,
    });
    render(
      <>
        <SensitiveValue kind="phone" value="13812345678" field="x" />
        <PageWatermark />
      </>,
    );
    // 加载前按最严格默认值：脱敏 + 页面水印（用户名 + 时间）
    expect(screen.getByTestId('sensitive-value')).toHaveTextContent('138****5678');
    expect(screen.getByTestId('page-watermark').getAttribute('data-watermark')).toMatch(
      /^auditor01 \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
    );
    await waitFor(() => expect(screen.getByText('13812345678')).toBeInTheDocument());
    expect(screen.queryByTestId('page-watermark')).not.toBeInTheDocument();
  });
});
