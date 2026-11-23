import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RowActionMenu } from './RowActionMenu';
import { TagCluster } from './TagCluster';
import { FormSection } from './FormSection';
import { SegmentTabs } from './SegmentTabs';
import { RadioPills } from './RadioPills';
import { NoteBox } from './NoteBox';

describe('RowActionMenu', () => {
  it('点击更多展开菜单，选择后触发操作并收起', async () => {
    const onSelect = vi.fn();
    render(<RowActionMenu items={[{ key: 'a', label: '模型指纹', onSelect }]} />);
    expect(screen.queryByRole('menu')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '更多' }));
    await userEvent.click(screen.getByRole('menuitem', { name: '模型指纹' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Esc 关闭；无条目时不渲染', async () => {
    const { container, rerender } = render(
      <RowActionMenu items={[{ key: 'a', label: '诊断', onSelect: () => {} }]} />,
    );
    await userEvent.click(screen.getByRole('button', { name: '更多' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    rerender(<RowActionMenu items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('禁用项不可触发', async () => {
    const onSelect = vi.fn();
    render(<RowActionMenu items={[{ key: 'a', label: '测试', disabled: true, onSelect }]} />);
    await userEvent.click(screen.getByRole('button', { name: '更多' }));
    expect(screen.getByRole('menuitem', { name: '测试' })).toBeDisabled();
  });
});

describe('TagCluster', () => {
  it('最多直接显示 3 个，其余折叠为 +N', () => {
    render(<TagCluster tags={['甲', '乙', '丙', '丁', '戊']} />);
    expect(screen.getByText('甲')).toBeInTheDocument();
    expect(screen.getByText('丙')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /另有 2 项：丁、戊/ })).toHaveTextContent('+2');
  });

  it('不超过上限时不出现 +N，空数组显示占位', () => {
    const { rerender } = render(<TagCluster tags={['甲', '乙']} />);
    expect(screen.queryByText(/^\+/)).toBeNull();
    rerender(<TagCluster tags={[]} empty={<span>无</span>} />);
    expect(screen.getByText('无')).toBeInTheDocument();
  });
});

describe('FormSection', () => {
  it('渲染标题、说明与字段', () => {
    render(
      <FormSection title="基本信息" description="说明文字">
        <input aria-label="名称" />
      </FormSection>,
    );
    expect(screen.getByText('基本信息')).toBeInTheDocument();
    expect(screen.getByText('说明文字')).toBeInTheDocument();
    expect(screen.getByLabelText('名称')).toBeInTheDocument();
  });
});

describe('SegmentTabs / RadioPills / NoteBox', () => {
  it('SegmentTabs 标记选中页签并回调', async () => {
    const onChange = vi.fn();
    render(
      <SegmentTabs
        ariaLabel="视图"
        value="a"
        onChange={onChange}
        items={[
          { value: 'a', label: '甲页' },
          { value: 'b', label: '乙页' },
        ]}
      />,
    );
    expect(screen.getByRole('tab', { name: '甲页' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(screen.getByRole('tab', { name: '乙页' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('RadioPills 使用原生 radio，可按标签选择', async () => {
    const onChange = vi.fn();
    render(
      <RadioPills
        name="m"
        value="x"
        onChange={onChange}
        options={[
          { value: 'x', label: '已有' },
          { value: 'y', label: '新建' },
        ]}
      />,
    );
    expect(screen.getByLabelText('已有')).toBeChecked();
    await userEvent.click(screen.getByLabelText('新建'));
    expect(onChange).toHaveBeenCalledWith('y');
  });

  it('NoteBox 渲染内容', () => {
    render(<NoteBox tone="warning">注意事项</NoteBox>);
    expect(screen.getByText('注意事项')).toBeInTheDocument();
  });
});
