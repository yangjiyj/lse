import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Table, TBody, TD, TH, THead, TR } from './table';

describe('Table responsive layout', () => {
  it('uses mobile card rows with cell labels instead of forcing desktop columns', () => {
    render(
      <Table>
        <THead>
          <TR>
            <TH>报告标题</TH>
            <TH>风险项</TH>
          </TR>
        </THead>
        <TBody>
          <TR>
            <TD data-label="报告标题">Agent 工具调用专项报告</TD>
            <TD data-label="风险项">72</TD>
          </TR>
        </TBody>
      </Table>,
    );

    const table = screen.getByRole('table');
    expect(table.className).toContain('max-md:block');
    expect(table.className).toContain('max-md:[&_td]:before:content-[attr(data-label)]');
    expect(screen.getByText('72')).toHaveAttribute('data-label', '风险项');
  });

  it('外层容器带 min-w-0 / max-w-full 并在桌面端横向滚动：放进 grid 列时不会撑破列宽把右侧列挤出视口', () => {
    render(
      <div className="grid xl:grid-cols-2">
        <Table aria-label="宽表">
          <THead>
            <TR>
              <TH>类别</TH>
              <TH>模型甲</TH>
              <TH>模型乙</TH>
            </TR>
          </THead>
          <TBody>
            <TR>
              <TD>提示注入</TD>
              <TD>75%</TD>
              <TD>50%</TD>
            </TR>
          </TBody>
        </Table>
      </div>,
    );
    const wrapper = screen.getByRole('table', { name: '宽表' }).parentElement!;
    expect(wrapper).toHaveClass('min-w-0', 'max-w-full', 'md:overflow-x-auto');
    // 第二个模型的列仍然在 DOM 里（不是被移除），由容器滚动呈现
    expect(screen.getByRole('columnheader', { name: '模型乙' })).toBeInTheDocument();
  });

  it('fit 模式保持固定表格布局，不受外层 min-w-0 影响', () => {
    render(
      <Table fit aria-label="定宽表">
        <TBody>
          <TR>
            <TD>内容</TD>
          </TR>
        </TBody>
      </Table>,
    );
    expect(screen.getByRole('table', { name: '定宽表' }).className).toContain('table-fixed');
  });
});
