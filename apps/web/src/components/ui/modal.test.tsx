import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from './modal';

describe('Modal 对话框语义', () => {
  it('带 role=dialog、aria-modal，并用标题命名', () => {
    render(
      <Modal open onClose={() => {}} title="修改密码" description="先验证当前密码">
        <p>内容</p>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog', { name: '修改密码' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('先验证当前密码');
    expect(dialog).toHaveTextContent('内容');
  });

  it('两个弹窗同时存在时标题 id 互不冲突', () => {
    render(
      <>
        <Modal open onClose={() => {}} title="弹窗甲">
          甲
        </Modal>
        <Modal open onClose={() => {}} title="弹窗乙">
          乙
        </Modal>
      </>,
    );
    expect(screen.getByRole('dialog', { name: '弹窗甲' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '弹窗乙' })).toBeInTheDocument();
  });

  it('没有标题时不写 aria-labelledby', () => {
    render(
      <Modal open onClose={() => {}}>
        内容
      </Modal>,
    );
    expect(screen.getByRole('dialog')).not.toHaveAttribute('aria-labelledby');
  });

  it('关闭状态不渲染', () => {
    render(
      <Modal open={false} onClose={() => {}} title="隐藏">
        内容
      </Modal>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('按 Esc 与点击关闭按钮仍然会关闭', async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="可关闭">
        内容
      </Modal>,
    );
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('外层已自带 dialog 语义的旧用法不再重复声明，避免同名对话框出现两次', () => {
    render(
      <div role="dialog" aria-modal="true" aria-label="新建批量评估弹窗">
        <Modal open onClose={() => {}} title="新建批量评估">
          内容
        </Modal>
      </div>,
    );
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: /新建批量评估/ })).toHaveAttribute(
      'aria-label',
      '新建批量评估弹窗',
    );
  });

  it('弹窗里再开弹窗时，内外层都保留对话框语义', () => {
    render(
      <Modal open onClose={() => {}} title="外层">
        <Modal open onClose={() => {}} title="内层">
          确认
        </Modal>
      </Modal>,
    );
    expect(screen.getByRole('dialog', { name: '外层' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '内层' })).toBeInTheDocument();
  });
  it('遮罩不受外层 space-y-* 的外边距影响（!m-0），避免弹窗顶部露出一条缝', () => {
    const { container } = render(
      <div className="space-y-5">
        <div>前一个兄弟</div>
        <Modal open onClose={() => {}} title="弹窗">
          内容
        </Modal>
      </div>,
    );
    const overlay = container.querySelector('div.fixed.inset-0');
    expect(overlay).toHaveClass('!m-0');
  });
});
